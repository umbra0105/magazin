import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { MediaProcessingError, type MediaProcessor } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";
import {
  MEDIA_JOB_OPTIONS,
  MEDIA_MAX_ATTEMPTS,
  MEDIA_QUEUE_NAME,
  type MediaJobData,
} from "./media-queue";

export interface MediaWorkerOptions {
  redisUrl: string;
  processor: Pick<MediaProcessor, "process">;
  logger: JobLogger;
  /** Joburi procesate simultan de acest worker; limita GLOBALĂ de decodări rămâne în `limiter`. */
  concurrency?: number;
  queueName?: string;
  /** Cât se amână un job când nu e loc în limita de decodări (cu jitter ±25%). */
  busyDelayMs?: number;
}

/**
 * Workerul cozii `media`. Când limita globală de decodări e plină, jobul NU eșuează și nu
 * consumă o încercare: e mutat în `delayed` și reluat mai târziu. Mesajele de eroare din Redis
 * și din loguri sunt doar coduri (`MediaProcessingError.code`), niciodată mesajul original.
 */
export function startMediaWorker(options: MediaWorkerOptions): Worker<MediaJobData> {
  const busyDelayMs = options.busyDelayMs ?? 10_000;
  const worker = new Worker<MediaJobData>(
    options.queueName ?? MEDIA_QUEUE_NAME,
    async (job, token) => {
      const maxAttempts = job.opts.attempts ?? MEDIA_MAX_ATTEMPTS;
      try {
        const outcome = await options.processor.process(job.data.mediaId, {
          finalAttempt: job.attemptsMade + 1 >= maxAttempts,
        });
        if (outcome.status === "busy") {
          const jitter = 0.75 + Math.random() * 0.5;
          await job.moveToDelayed(Date.now() + Math.round(busyDelayMs * jitter), token);
          throw new DelayedError();
        }
      } catch (error) {
        if (error instanceof DelayedError) throw error;
        if (error instanceof MediaProcessingError) {
          // `cause` e tot un MediaProcessingError (mesajul lui e doar codul): sigur de atașat.
          // UnrecoverableError (BullMQ) nu acceptă `cause`; mesajul e oricum doar codul.
          if (!error.retryable) throw new UnrecoverableError(error.code);
          throw new Error(error.code, { cause: error });
        }
        // Nu atașăm eroarea originală: mesajul ei poate conține chei, căi sau adrese, iar BullMQ
        // păstrează în Redis `failedReason` și stack-ul. Detaliul tehnic nu se persistă.
        // eslint-disable-next-line preserve-caught-error -- intenționat: fără `cause`, vezi mai sus
        throw new Error("UNEXPECTED");
      }
    },
    {
      connection: redisConnectionFromUrl(options.redisUrl),
      concurrency: options.concurrency ?? 2,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? MEDIA_JOB_OPTIONS.attempts ?? 1;
    options.logger.warn(
      {
        jobId: job.id,
        attempt: job.attemptsMade,
        willRetry: job.attemptsMade < maxAttempts && error.name !== "UnrecoverableError",
        reason: error.message,
      },
      "media: procesarea a eșuat",
    );
  });
  worker.on("error", (error) => {
    options.logger.error({ reason: error.message }, "worker media: eroare");
  });
  return worker;
}
