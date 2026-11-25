import { Worker } from "bullmq";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";
import { NIR_IMPORT_QUEUE_NAME, type NirImportJobData } from "./nir-queue";

export interface NirImportWorkerOptions {
  redisUrl: string;
  /** Rulează importul (`NirImportService.runQueued`). Nu aruncă pentru erori de aplicare: le consemnează pe import. */
  run: (importId: string) => Promise<void>;
  logger: JobLogger;
  queueName?: string;
}

/**
 * Workerul cozii `nir-import`: un import odată (concurență 1). Logurile conțin doar identificatorul jobului; nimic din fișier
 * (coduri, costuri) nu se scrie în loguri sau în Redis; starea importului, cu mesajul pentru administrator, e în baza de date.
 */
export function startNirImportWorker(options: NirImportWorkerOptions): Worker<NirImportJobData> {
  const worker = new Worker<NirImportJobData>(
    options.queueName ?? NIR_IMPORT_QUEUE_NAME,
    async (job) => {
      await options.run(job.data.importId);
    },
    { connection: redisConnectionFromUrl(options.redisUrl), concurrency: 1 },
  );
  worker.on("failed", (job) => {
    options.logger.warn({ jobId: job?.id }, "import NIR: jobul din fundal a eșuat");
  });
  worker.on("error", (error) => {
    options.logger.error({ reason: error.message }, "worker import NIR: eroare");
  });
  return worker;
}
