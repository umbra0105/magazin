import { Queue, type JobsOptions } from "bullmq";
import { sealEmailPayload, type EmailPayload, type SealedEmailJob } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";

export const EMAIL_QUEUE_NAME = "emails";

/**
 * Retry cu backoff exponențial: 5 încercări, la ~10s, 20s, 40s, 80s după primul eșec. Joburile
 * reușite se șterg imediat; cele eșuate rămân 24h (payload-ul lor e criptat, nu conține nimic în
 * clar) ca să poată fi diagnosticate.
 */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type EmailQueue = Queue<SealedEmailJob>;

export function createEmailQueue(
  redisUrl: string,
  options: { backoffDelayMs?: number; queueName?: string } = {},
) {
  const defaultJobOptions: JobsOptions = {
    ...EMAIL_JOB_OPTIONS,
    ...(options.backoffDelayMs !== undefined && {
      backoff: { type: "exponential", delay: options.backoffDelayMs },
    }),
  };
  return new Queue<SealedEmailJob>(options.queueName ?? EMAIL_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions,
  });
}

/** Pune un email în coadă, cu payload-ul criptat cu o cheie derivată din `APP_KEY`. */
export async function enqueueEmail(
  queue: EmailQueue,
  appKey: string,
  payload: EmailPayload,
): Promise<void> {
  await queue.add("send", sealEmailPayload(appKey, payload));
}
