import { Worker } from "bullmq";
import type { SealedEmailJob } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";
import { createEmailProcessor, type EmailProcessorDeps, type JobLogger } from "./email-processor";
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE_NAME } from "./queues";

/**
 * Pornește workerul de emailuri. Logurile conțin doar identificatori și numere (vezi
 * `createEmailProcessor`); `failedReason` e deja curățat de procesor.
 */
export function startEmailWorker(options: {
  redisUrl: string;
  deps: EmailProcessorDeps;
  logger: JobLogger;
  concurrency?: number;
  /** Numele cozii (implicit `emails`); altul doar în teste, ca să nu se amestece cu aplicația. */
  queueName?: string;
}): Worker<SealedEmailJob> {
  const processor = createEmailProcessor(options.deps);
  const worker = new Worker<SealedEmailJob>(
    options.queueName ?? EMAIL_QUEUE_NAME,
    (job) => processor({ id: job.id, data: job.data, attemptsMade: job.attemptsMade }),
    {
      connection: redisConnectionFromUrl(options.redisUrl),
      concurrency: options.concurrency ?? 5,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? EMAIL_JOB_OPTIONS.attempts ?? 1;
    options.logger.warn(
      {
        jobId: job.id,
        kind: job.data.kind,
        attempt: job.attemptsMade,
        willRetry: job.attemptsMade < maxAttempts && error.name !== "UnrecoverableError",
        // `error.message` a trecut deja prin `redactSecrets` în procesor.
        reason: error.message,
      },
      "email: trimiterea a eșuat",
    );
  });
  worker.on("error", (error) => {
    // Erori de conexiune la Redis etc.; fără date de job.
    options.logger.error({ reason: error.message }, "worker email: eroare");
  });
  return worker;
}
