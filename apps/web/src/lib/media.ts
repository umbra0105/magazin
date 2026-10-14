import { loadEnv } from "@ecom/config";
import {
  MediaLibraryService,
  MediaService,
  MediaUploadGuard,
  createMediaUsageRegistry,
  MemoryDecodeLimiter,
  RedisDecodeLimiter,
  ResilientDecodeLimiter,
  createPrismaLibraryStore,
  createPrismaMediaStore,
  createPrismaProcessingStore,
  type DecodeLimiter,
  type MediaUploadDeps,
  type MediaUsageRegistry,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createMediaQueue, enqueueMediaProcessing, type MediaQueue } from "@ecom/jobs";
import { createStorage, type StorageDriver } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";
import { getCurrentSubject } from "./session";
import { getCounterStore, getRedis, getSettings } from "./services";

const globalForMedia = globalThis as unknown as {
  __ecomStorage?: StorageDriver;
  __ecomMedia?: MediaService;
  __ecomMediaQueue?: MediaQueue;
  __ecomDecodeLimiter?: DecodeLimiter;
  __ecomMediaUsage?: MediaUsageRegistry;
  __ecomMediaLibrary?: MediaLibraryService;
};

const ENQUEUE_TIMEOUT_MS = 5000;

/** O singură coadă `media` (și conexiune Redis) per proces. */
export function getMediaQueue(): MediaQueue {
  if (!globalForMedia.__ecomMediaQueue) {
    const queue = createMediaQueue(loadEnv().REDIS_URL);
    // Fără handler, o eroare de conexiune ar opri procesul; enqueue-ul are propriul timeout.
    queue.on("error", () => undefined);
    globalForMedia.__ecomMediaQueue = queue;
  }
  return globalForMedia.__ecomMediaQueue;
}

/**
 * Limita GLOBALĂ de decodări de imagini (aceeași cheie Redis ca în worker): max. 2 simultan în
 * toată instalarea. Dacă Redis cade, limita rămâne per proces.
 */
export function getDecodeLimiter(): DecodeLimiter {
  globalForMedia.__ecomDecodeLimiter ??= new ResilientDecodeLimiter(
    new RedisDecodeLimiter(getRedis()),
    new MemoryDecodeLimiter(),
    getLogger(),
  );
  return globalForMedia.__ecomDecodeLimiter;
}

async function enqueueWithTimeout(mediaId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      enqueueMediaProcessing(getMediaQueue(), mediaId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout la punerea în coadă")),
          ENQUEUE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Driverul de storage din `.env` (`STORAGE_DRIVER`). Un singur obiect per proces. */
export function getStorage(): StorageDriver {
  globalForMedia.__ecomStorage ??= createStorage(loadEnv());
  return globalForMedia.__ecomStorage;
}

export function getMediaService(): MediaService {
  globalForMedia.__ecomMedia ??= new MediaService({
    store: createPrismaMediaStore(getDb()),
    storage: getStorage(),
    limiter: getDecodeLimiter(),
    // Procesarea (variante, blurhash) rulează în worker, nu în cerere. Dacă punerea în coadă
    // eșuează, fișierul rămâne `pending` și se reia cu `pnpm media:regenerate`.
    onCreated: (media) => enqueueWithTimeout(media.id),
  });
  return globalForMedia.__ecomMedia;
}

/** Dependențele rutei `POST /api/media`, legate la serviciile reale ale aplicației. */
export function getMediaUploadDeps(): MediaUploadDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: async () => {
      const settings = getSettings();
      const [media, auth] = await Promise.all([
        settings.getGroup("media"),
        settings.getGroup("auth"),
      ]);
      return { media, trustedProxyHops: auth.trustedProxyHops };
    },
    appUrl: loadEnv().APP_URL,
    createGuard: (media) => new MediaUploadGuard(getCounterStore(), media),
    service: getMediaService(),
    audit: getAudit(),
  };
}

/**
 * Registrul locurilor unde sunt folosite fișierele media. Modulele care referă media (produse,
 * pagini, bannere) își înregistrează aici un `MediaUsageProvider`; ștergerea se refuză cât timp
 * un provider îl raportează folosit. Un singur obiect per proces.
 */
export function getMediaUsageRegistry(): MediaUsageRegistry {
  globalForMedia.__ecomMediaUsage ??= createMediaUsageRegistry(getDb());
  return globalForMedia.__ecomMediaUsage;
}

/** Biblioteca media din admin (citire, editare, foldere, ștergere, regenerare), cu audit. */
export function getMediaLibrary(): MediaLibraryService {
  globalForMedia.__ecomMediaLibrary ??= new MediaLibraryService({
    store: createPrismaLibraryStore(getDb()),
    storage: getStorage(),
    audit: getAudit(),
    usage: getMediaUsageRegistry(),
    processing: createPrismaProcessingStore(getDb()),
    queue: { enqueueProcess: (mediaId) => enqueueWithTimeout(mediaId) },
  });
  return globalForMedia.__ecomMediaLibrary;
}
