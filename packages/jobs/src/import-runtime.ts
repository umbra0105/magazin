import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  AuditService,
  SettingsService,
  createPrismaAuditStore,
  createPrismaSettingsStore,
  createProductImportService,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createStorage } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { createImageImportQueue, imageJobQueue } from "./image-import-queue";
import { startImportWorker } from "./import-worker";

/** Pornește workerul `product-import` cu dependențele reale. Folosit de `pnpm worker` și de `pnpm dev:web`. */
export function startImportWorkerFromEnv() {
  const env = loadEnv();
  const logger = getLogger();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe DB
  const db = getDb();
  const imageQueue = createImageImportQueue(env.REDIS_URL);
  imageQueue.on("error", () => undefined);
  const service = createProductImportService({
    db,
    storage: createStorage(env),
    settings: new SettingsService(createPrismaSettingsStore(db), redis),
    audit: new AuditService(createPrismaAuditStore(db)),
    logger,
    // imaginile se descarcă în jobul lor, după ce produsele sunt create
    imageQueue: imageJobQueue(imageQueue),
    // fără `queue`: jobul rulează deja în fundal; fără `invalidate`: cache-ul se invalidează din aplicație
  });
  const worker = startImportWorker({
    redisUrl: env.REDIS_URL,
    run: (importId) => service.runQueued(importId),
    logger,
  });
  return {
    worker,
    async close() {
      await worker.close();
      await imageQueue.close();
      redis.disconnect();
    },
  };
}
