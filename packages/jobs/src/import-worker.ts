import { Worker } from "bullmq";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";
import { IMPORT_QUEUE_NAME, type ImportJobData } from "./import-queue";

export interface ImportWorkerOptions {
  redisUrl: string;
  /** Rulează importul (ex. `ProductImportService.runQueued`). Nu aruncă pentru erori de rând. */
  run: (importId: string) => Promise<void>;
  logger: JobLogger;
  queueName?: string;
}

/**
 * Workerul cozii `product-import`: un import odată (concurență 1), ca două importuri mari să nu se
 * calce pe același catalog. Logurile conțin doar identificatorul jobului; motivul unui eșec nu se
 * copiază în Redis (starea importului, cu mesajul pentru administrator, e în baza de date).
 */
export function startImportWorker(options: ImportWorkerOptions): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(
    options.queueName ?? IMPORT_QUEUE_NAME,
    async (job) => {
      await options.run(job.data.importId);
    },
    { connection: redisConnectionFromUrl(options.redisUrl), concurrency: 1 },
  );
  worker.on("failed", (job) => {
    options.logger.warn({ jobId: job?.id }, "import: jobul din fundal a eșuat");
  });
  worker.on("error", (error) => {
    options.logger.error({ reason: error.message }, "worker import: eroare");
  });
  return worker;
}
