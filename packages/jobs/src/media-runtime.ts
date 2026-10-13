import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  MediaProcessor,
  MemoryDecodeLimiter,
  RedisDecodeLimiter,
  RedisMediaLock,
  ResilientDecodeLimiter,
  SettingsService,
  createPrismaProcessingStore,
  createPrismaSettingsStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createStorage } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { startMediaWorker } from "./media-worker";

/**
 * Procesorul real: storage-ul din `.env`, setările din DB (cu cache Redis) și limita GLOBALĂ de
 * decodări în Redis (aceeași cheie ca în aplicație), cu rezervă în memorie dacă Redis cade.
 */
export function createMediaRuntime(): {
  processor: MediaProcessor;
  redisUrl: string;
  close(): void;
} {
  const env = loadEnv();
  const logger = getLogger();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // limita cade pe memorie, setările pe DB
  const db = getDb();
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);

  const processor = new MediaProcessor({
    store: createPrismaProcessingStore(db),
    storage: createStorage(env),
    limiter: new ResilientDecodeLimiter(
      new RedisDecodeLimiter(redis),
      new MemoryDecodeLimiter(),
      logger,
    ),
    lock: new RedisMediaLock(redis),
    getSettings: () => settings.getGroup("media"),
    logger,
  });
  return { processor, redisUrl: env.REDIS_URL, close: () => redis.disconnect() };
}

/** Pornește workerul `media` cu dependențele reale. Folosit de `pnpm worker` și de `pnpm dev:web`. */
export function startMediaWorkerFromEnv() {
  const runtime = createMediaRuntime();
  const worker = startMediaWorker({
    redisUrl: runtime.redisUrl,
    processor: runtime.processor,
    logger: getLogger(),
  });
  return {
    worker,
    async close() {
      await worker.close();
      runtime.close();
    },
  };
}
