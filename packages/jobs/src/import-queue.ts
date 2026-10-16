import { Queue, type JobsOptions } from "bullmq";
import type { ImportJobQueue } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";

export const IMPORT_QUEUE_NAME = "product-import";

/** Datele jobului: doar identificatorul importului. Nu există nimic sensibil în Redis. */
export interface ImportJobData {
  importId: string;
}

/**
 * O SINGURĂ încercare automată: un import care cade la mijloc nu se reia pe orb. Rândurile deja aplicate
 * rămân, iar administratorul reia verificarea (rândurile aplicate apar atunci ca „neschimbate”) și
 * aplică din nou. Jobul reușit se șterge; cel eșuat rămâne 24h pentru diagnostic.
 */
export const IMPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type ImportQueue = Queue<ImportJobData>;

export function createImportQueue(
  redisUrl: string,
  options: { queueName?: string } = {},
): ImportQueue {
  return new Queue<ImportJobData>(options.queueName ?? IMPORT_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions: IMPORT_JOB_OPTIONS,
  });
}

/** Pune importul în coadă; `jobId` stabil, deci aceeași cerere repetată nu dublează jobul. */
export async function enqueueProductImport(queue: ImportQueue, importId: string): Promise<void> {
  await queue.add("import", { importId }, { jobId: `import-${importId}` });
}

/** Adaptorul cerut de `ProductImportService`, cu un timeout la punerea în coadă. */
export function importJobQueue(queue: ImportQueue, timeoutMs = 5000): ImportJobQueue {
  return {
    async enqueue(importId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          enqueueProductImport(queue, importId),
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
