import { Worker } from "bullmq";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";
import { IMAGE_IMPORT_QUEUE_NAME, type ImageImportJobData } from "./image-import-queue";

export interface ImageImportWorkerOptions {
  redisUrl: string;
  /** Aduce imaginile unui import (ex. `ProductImageImporter.run`). Nu aruncă pentru erori pe imagine. */
  run: (importId: string) => Promise<unknown>;
  logger: JobLogger;
  queueName?: string;
}

/**
 * Workerul cozii `product-import-images`: un import odată (concurența pe imagini e în importator, cu limite
 * globale și pe gazdă). Logurile conțin doar identificatorul jobului; motivul unui eșec nu se copiază în Redis.
 */
export function startImageImportWorker(
  options: ImageImportWorkerOptions,
): Worker<ImageImportJobData> {
  const worker = new Worker<ImageImportJobData>(
    options.queueName ?? IMAGE_IMPORT_QUEUE_NAME,
    async (job) => {
      await options.run(job.data.importId);
    },
    { connection: redisConnectionFromUrl(options.redisUrl), concurrency: 1 },
  );
  worker.on("failed", (job) => {
    options.logger.warn({ jobId: job?.id }, "import imagini: jobul din fundal a eșuat");
  });
  worker.on("error", (error) => {
    options.logger.error({ reason: error.name }, "worker import imagini: eroare");
  });
  return worker;
}
