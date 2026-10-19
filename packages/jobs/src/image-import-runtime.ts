import { loadEnv } from "@ecom/config";
import {
  AuditService,
  MediaProcessingError,
  createPrismaAuditStore,
  createProductImageImporter,
  type ImageProcessOutcome,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createStorage } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { startImageImportWorker } from "./image-import-worker";
import { createMediaRuntime } from "./media-runtime";

const BUSY_RETRIES = 10;
const BUSY_WAIT_MS = 2000;

/** Pornește workerul `product-import-images` cu dependențele reale. Folosit de `pnpm worker` și de `pnpm dev:web`. */
export function startImageImportWorkerFromEnv() {
  const env = loadEnv();
  const logger = getLogger();
  const media = createMediaRuntime();
  const db = getDb();

  const processMedia = async (mediaId: string): Promise<ImageProcessOutcome> => {
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
      try {
        const outcome = await media.processor.process(mediaId, { finalAttempt: true });
        if (outcome.status === "ready") return "ready";
        if (outcome.status === "skipped") return "failed";
        // limita globală de decodări e plină: se așteaptă și se încearcă din nou
        await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
      } catch (error) {
        if (error instanceof MediaProcessingError) return "failed";
        throw error;
      }
    }
    return "busy";
  };

  const importer = createProductImageImporter({
    db,
    storage: createStorage(env),
    settings: media.settings,
    audit: new AuditService(createPrismaAuditStore(db)),
    limiter: media.limiter,
    processMedia,
    logger,
    // cache-ul catalogului se invalidează din aplicație (revalidarea pe etichete nu există în worker)
  });
  const worker = startImageImportWorker({
    redisUrl: media.redisUrl,
    run: (importId) => importer.run(importId),
    logger,
  });
  return {
    worker,
    async close() {
      await worker.close();
      media.close();
    },
  };
}
