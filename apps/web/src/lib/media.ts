import { loadEnv } from "@ecom/config";
import {
  MediaService,
  MediaUploadGuard,
  createPrismaMediaStore,
  type MediaUploadDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createStorage, type StorageDriver } from "@ecom/integrations";
import { getAudit } from "./admin-writes";
import { getCurrentSubject } from "./session";
import { getCounterStore, getSettings } from "./services";

const globalForMedia = globalThis as unknown as {
  __ecomStorage?: StorageDriver;
  __ecomMedia?: MediaService;
};

/** Driverul de storage din `.env` (`STORAGE_DRIVER`). Un singur obiect per proces. */
export function getStorage(): StorageDriver {
  globalForMedia.__ecomStorage ??= createStorage(loadEnv());
  return globalForMedia.__ecomStorage;
}

export function getMediaService(): MediaService {
  globalForMedia.__ecomMedia ??= new MediaService({
    store: createPrismaMediaStore(getDb()),
    storage: getStorage(),
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
