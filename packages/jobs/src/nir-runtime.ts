import { loadEnv } from "@ecom/config";
import {
  AuditService,
  NirImportService,
  createPrismaAuditStore,
  createPrismaNirStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { startNirImportWorker } from "./nir-worker";

/** Pornește workerul `nir-import` cu dependențele reale. Folosit de `pnpm worker` și de `pnpm dev:web`. */
export function startNirImportWorkerFromEnv() {
  const env = loadEnv();
  const logger = getLogger();
  const db = getDb();
  // fără `queue`: jobul rulează deja în fundal (serviciul doar aplică)
  const service = new NirImportService({
    store: createPrismaNirStore(db),
    audit: new AuditService(createPrismaAuditStore(db)),
    logger,
  });
  const worker = startNirImportWorker({
    redisUrl: env.REDIS_URL,
    run: (importId) => service.runQueued(importId),
    logger,
  });
  return {
    worker,
    async close() {
      await worker.close();
    },
  };
}
