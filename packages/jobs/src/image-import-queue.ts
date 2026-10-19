import { Queue, type JobsOptions } from "bullmq";
import type { ImageJobQueue } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";

export const IMAGE_IMPORT_QUEUE_NAME = "product-import-images";

/** Datele jobului: doar identificatorul importului. Nu există nimic sensibil în Redis (nici adrese). */
export interface ImageImportJobData {
  importId: string;
}

/**
 * O SINGURĂ încercare automată: imaginile eșuate se reiau din pagina importului («Reia imaginile»), nu pe orb.
 * Un job pe import (`jobId` stabil), deci aceeași cerere repetată nu pornește două descărcări în paralel.
 */
export const IMAGE_IMPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type ImageImportQueue = Queue<ImageImportJobData>;

export function createImageImportQueue(
  redisUrl: string,
  options: { queueName?: string } = {},
): ImageImportQueue {
  return new Queue<ImageImportJobData>(options.queueName ?? IMAGE_IMPORT_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions: IMAGE_IMPORT_JOB_OPTIONS,
  });
}

export async function enqueueImageImport(queue: ImageImportQueue, importId: string): Promise<void> {
  await queue.add("images", { importId }, { jobId: `import-images-${importId}` });
}

/** Adaptorul cerut de `ProductImportService`, cu un timeout la punerea în coadă. */
export function imageJobQueue(queue: ImageImportQueue, timeoutMs = 5000): ImageJobQueue {
  return {
    async enqueue(importId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          enqueueImageImport(queue, importId),
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
