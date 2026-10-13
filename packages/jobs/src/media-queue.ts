import { Queue, type JobsOptions } from "bullmq";
import type { MediaJobQueue } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";

export const MEDIA_QUEUE_NAME = "media";

/** Datele jobului: doar identificatorul. Nu există nimic sensibil în Redis. */
export interface MediaJobData {
  mediaId: string;
}

export const MEDIA_MAX_ATTEMPTS = 5;

/**
 * 5 încercări cu backoff exponențial (~10s, 20s, 40s, 80s). Jobul reușit se șterge; cel eșuat
 * rămâne 24h pentru diagnostic (conține doar `mediaId` și un cod de motiv).
 */
export const MEDIA_JOB_OPTIONS: JobsOptions = {
  attempts: MEDIA_MAX_ATTEMPTS,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type MediaQueue = Queue<MediaJobData>;

export function createMediaQueue(
  redisUrl: string,
  options: { backoffDelayMs?: number; queueName?: string; attempts?: number } = {},
): MediaQueue {
  const defaultJobOptions: JobsOptions = {
    ...MEDIA_JOB_OPTIONS,
    ...(options.attempts !== undefined && { attempts: options.attempts }),
    ...(options.backoffDelayMs !== undefined && {
      backoff: { type: "exponential", delay: options.backoffDelayMs },
    }),
  };
  return new Queue<MediaJobData>(options.queueName ?? MEDIA_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions,
  });
}

/**
 * Pune procesarea unui fișier în coadă, fără să dubleze și fără să piardă cereri:
 *
 *  - fără job în curs: se adaugă jobul principal (`media-<id>`); unul vechi terminat/eșuat se
 *    scoate întâi, ca regenerarea să poată porni din nou;
 *  - job principal în așteptare sau amânat: nu se adaugă nimic (va rula oricum cu datele curente);
 *  - job principal ACTIV (rulează chiar acum, deci nu va vedea cererea): se adaugă un job
 *    `media-<id>-rerun`, o singură dată. Lock-ul per fișier din procesor le face să ruleze pe rând.
 */
export async function enqueueMediaProcessing(queue: MediaQueue, mediaId: string): Promise<void> {
  const primaryId = `media-${mediaId}`;
  const rerunId = `${primaryId}-rerun`;

  const primary = await queue.getJob(primaryId);
  if (primary) {
    const state = await primary.getState();
    if (state === "failed" || state === "completed") {
      await primary.remove();
    } else if (state !== "active") {
      return; // waiting / delayed / prioritized: va procesa oricum starea curentă
    } else {
      const rerun = await queue.getJob(rerunId);
      if (rerun) {
        const rerunState = await rerun.getState();
        if (rerunState === "failed" || rerunState === "completed") await rerun.remove();
        else return; // există deja o reluare programată după jobul activ
      }
      await queue.add("process", { mediaId }, { jobId: rerunId });
      return;
    }
  }
  await queue.add("process", { mediaId }, { jobId: primaryId });
}

/** Adaptorul portului `MediaJobQueue` din `@ecom/core`. */
export function mediaJobQueue(queue: MediaQueue): MediaJobQueue {
  return { enqueueProcess: (mediaId) => enqueueMediaProcessing(queue, mediaId) };
}
