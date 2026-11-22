import { Queue, Worker, type JobsOptions } from "bullmq";
import { redisConnectionFromUrl } from "./connection";
import type { JobLogger } from "./email-processor";

/**
 * Coada `invoices` (Faza 13): emiterea documentelor fiscale din outbox-ul `invoice`. Jobul poartă DOAR identificatorul documentului
 * (nicio sumă, niciun nume, nicio cheie în Redis); `jobId` = documentul și încercarea lui, deci același document nu se pune de două ori
 * în coadă. Reîncercările cu backoff, alerta și rezultatul nesigur le ține baza de date (outbox-ul), nu BullMQ: un job eșuat
 * din BullMQ nu retrimite singur o emitere (risc de document dublu), de aceea `attempts: 1`. Un SINGUR lucrător, o emitere o
 * dată: și protecția față de limita SmartBill (30 de apeluri la 10 secunde per token; la depășire accesul se blochează 10 minute).
 */
export const INVOICE_QUEUE_NAME = "invoices";

export const INVOICE_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface InvoiceJob {
  invoiceId: string;
}

export type InvoiceQueue = Queue<InvoiceJob>;

export function createInvoiceQueue(
  redisUrl: string,
  options: { queueName?: string } = {},
): InvoiceQueue {
  return new Queue<InvoiceJob>(options.queueName ?? INVOICE_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions: INVOICE_JOB_OPTIONS,
  });
}

/** `attempt` = câte încercări are documentul până acum: o nouă încercare e alt job, iar aceeași încercare nu se dublează. */
export async function enqueueInvoice(
  queue: InvoiceQueue,
  invoiceId: string,
  attempt: number,
): Promise<void> {
  await queue.add("issue", { invoiceId }, { jobId: `invoice-${invoiceId}-${attempt}` });
}

export interface InvoiceWorkerOptions {
  redisUrl: string;
  /** Procesează un document (idempotent). */
  process: (invoiceId: string) => Promise<void>;
  logger: JobLogger;
  queueName?: string;
}

export function startInvoiceWorker(options: InvoiceWorkerOptions): Worker<InvoiceJob> {
  const worker = new Worker<InvoiceJob>(
    options.queueName ?? INVOICE_QUEUE_NAME,
    async (job) => {
      try {
        await options.process(job.data.invoiceId);
      } catch {
        // în Redis și în loguri nu intră mesajul original (poate conține referințe de document)
        throw new Error("INVOICE_JOB_FAILED");
      }
    },
    { connection: redisConnectionFromUrl(options.redisUrl), concurrency: 1 },
  );
  worker.on("failed", (job, error) => {
    options.logger.warn(
      { queue: INVOICE_QUEUE_NAME, attemptsMade: job?.attemptsMade, code: error.message },
      "facturare: procesarea unui document a eșuat",
    );
  });
  worker.on("error", () => undefined);
  return worker;
}
