import { Queue, Worker, type JobsOptions } from "bullmq";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";

/**
 * Coada `payment-events` (Faza 10): fiecare notificare de plată înregistrată (cu semnătură validă) se procesează ASINCRON, cu
 * reîncercări cu backoff exponențial. Jobul poartă DOAR identificatorul evenimentului din baza de date (niciun conținut, nicio
 * sumă, niciun secret în Redis). `jobId` = identificatorul evenimentului: același eveniment nu se pune de două ori în coadă.
 * Joburile eșuate rămân 7 zile (dead-letter), iar evenimentul rămâne «failed» în bază, vizibil în ecranul de plăți.
 */
export const PAYMENT_QUEUE_NAME = "payment-events";
export const PAYMENT_MAX_ATTEMPTS = 6;

export const PAYMENT_JOB_OPTIONS: JobsOptions = {
  attempts: PAYMENT_MAX_ATTEMPTS,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface PaymentEventJob {
  eventId: string;
}

export type PaymentQueue = Queue<PaymentEventJob>;

export function createPaymentQueue(
  redisUrl: string,
  options: { queueName?: string; backoffDelayMs?: number } = {},
): PaymentQueue {
  return new Queue<PaymentEventJob>(options.queueName ?? PAYMENT_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions: {
      ...PAYMENT_JOB_OPTIONS,
      ...(options.backoffDelayMs !== undefined && {
        backoff: { type: "exponential", delay: options.backoffDelayMs },
      }),
    },
  });
}

export async function enqueuePaymentEvent(queue: PaymentQueue, eventId: string): Promise<void> {
  await queue.add("process", { eventId }, { jobId: `payment-event-${eventId}` });
}

export interface PaymentWorkerOptions {
  redisUrl: string;
  /** Procesează un eveniment (idempotent); aruncă la eroare ca să se reîncerce. */
  process: (eventId: string) => Promise<void>;
  logger: JobLogger;
  queueName?: string;
  concurrency?: number;
}

export function startPaymentWorker(options: PaymentWorkerOptions): Worker<PaymentEventJob> {
  const worker = new Worker<PaymentEventJob>(
    options.queueName ?? PAYMENT_QUEUE_NAME,
    async (job) => {
      try {
        await options.process(job.data.eventId);
      } catch (error) {
        // în Redis și în loguri intră doar un cod scurt, niciodată mesajul original (poate conține referințe de plată)
        // doar un cod de forma MAJUSCULE_CU_UNDERSCORE (primul cuvânt al mesajului); orice altceva devine UNEXPECTED
        const first = error instanceof Error ? (error.message.split(/\s/)[0] ?? "") : "";
        const code = /^[A-Z][A-Z0-9_]{2,59}$/.test(first) ? first : "UNEXPECTED";
        // eslint-disable-next-line preserve-caught-error -- intenționat: fără `cause`, BullMQ păstrează stack-ul în Redis
        throw new Error(code);
      }
    },
    {
      connection: redisConnectionFromUrl(options.redisUrl),
      concurrency: options.concurrency ?? 4,
    },
  );
  worker.on("failed", (job, error) => {
    options.logger.warn(
      { queue: PAYMENT_QUEUE_NAME, attemptsMade: job?.attemptsMade, code: error.message },
      "plăți: procesarea unui eveniment a eșuat",
    );
  });
  worker.on("error", () => undefined);
  return worker;
}
