import { Queue, type JobsOptions } from "bullmq";
import type { NirJobQueue } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";
import { removeFinishedJob } from "./import-queue";

export const NIR_IMPORT_QUEUE_NAME = "nir-import";

/** Datele jobului: doar identificatorul importului (prețurile de achiziție nu ajung niciodată în Redis). */
export interface NirImportJobData {
  importId: string;
}

/**
 * O SINGURĂ încercare automată: un import care cade la mijloc nu se reia pe orb (rândurile deja aplicate rămân; aplicarea e
 * idempotentă, deci încărcarea din nou a fișierului le arată «neschimbate»). Jobul reușit se șterge; cel eșuat rămâne 24 h.
 */
export const NIR_IMPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type NirImportQueue = Queue<NirImportJobData>;

export function createNirImportQueue(
  redisUrl: string,
  options: { queueName?: string } = {},
): NirImportQueue {
  return new Queue<NirImportJobData>(options.queueName ?? NIR_IMPORT_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions: NIR_IMPORT_JOB_OPTIONS,
  });
}

/** Pune importul în coadă; `jobId` stabil, deci aceeași cerere repetată nu dublează jobul. */
export async function enqueueNirImport(queue: NirImportQueue, importId: string): Promise<void> {
  const jobId = `nir-import-${importId}`;
  await removeFinishedJob(queue, jobId);
  await queue.add("nir-import", { importId }, { jobId });
}

/** Adaptorul cerut de `NirImportService`, cu un timeout la punerea în coadă. */
export function nirJobQueue(queue: NirImportQueue, timeoutMs = 5000): NirJobQueue {
  return {
    async enqueue(importId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          enqueueNirImport(queue, importId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout la punerea în coadă")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
