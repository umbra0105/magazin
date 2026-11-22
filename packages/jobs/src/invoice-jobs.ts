import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import { InvoiceService, InvoicingConfigService, readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import type { Queue, Worker } from "bullmq";
import {
  createInvoiceQueue,
  enqueueInvoice,
  startInvoiceWorker,
  type InvoiceJob,
} from "./invoice-queue";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Joburile facturării (Faza 13), toate idempotente și sigure la mai multe instanțe:
 *  - `invoices` (BullMQ): emite documentul din outbox (preluare atomică; un singur lucrător, deci cel mult o emitere odată);
 *  - `invoice-sweep` (15 s): pune în coadă documentele scadente (în coadă, cu `nextAttemptAt` trecut) și trece în «eșuat»
 *    documentele rămase «în emitere» peste termen (proces căzut = rezultat nesigur, fără reîncercare automată);
 *  - `invoice-efactura` (5 minute): reîmprospătează starea e-Factura la furnizorii care o raportează (SmartBill: niciodată).
 */
export const INVOICE_JOB_SCHEDULES = {
  sweep: { everyMs: 15_000 },
  efactura: { everyMs: 300_000 },
} as const;

export interface InvoiceJobsHandle {
  worker: Worker<InvoiceJob>;
  queue: Queue<InvoiceJob>;
  jobs: PeriodicJobHandle[];
  close(): Promise<void>;
}

export function createInvoiceServiceFromEnv(): InvoiceService {
  const env = loadEnv();
  const db = getDb();
  const config = new InvoicingConfigService({ db, appKey: env.APP_KEY, env: readDemoGuardEnv() });
  return new InvoiceService({ db, source: config });
}

export function startInvoiceJobsFromEnv(): InvoiceJobsHandle {
  const env = loadEnv();
  const logger: PeriodicJobLogger = getLogger();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  const service = createInvoiceServiceFromEnv();
  const queue = createInvoiceQueue(env.REDIS_URL);
  const worker = startInvoiceWorker({
    redisUrl: env.REDIS_URL,
    logger: getLogger(),
    process: async (invoiceId) => {
      await service.processById(invoiceId);
    },
  });
  const jobs: PeriodicJobHandle[] = [
    startPeriodicJob({
      name: "invoice-sweep",
      schedule: INVOICE_JOB_SCHEDULES.sweep,
      run: async () => {
        const recovered = await service.recoverStale();
        const ids = await service.listDueIds(50);
        const due = await db.invoice.findMany({
          where: { id: { in: ids } },
          select: { id: true, attempts: true },
        });
        for (const doc of due) await enqueueInvoice(queue, doc.id, doc.attempts);
        return { recovered, enqueued: due.length };
      },
      summarize: (r) => (r.recovered === 0 && r.enqueued === 0 ? null : r),
      logger,
      initialDelayMs: 20_000,
    }),
    startPeriodicJob({
      name: "invoice-efactura",
      schedule: INVOICE_JOB_SCHEDULES.efactura,
      run: async () => ({ changed: await service.refreshEfactura() }),
      summarize: (r) => (r.changed === 0 ? null : r),
      logger,
      initialDelayMs: 60_000,
    }),
  ];
  logger.info(
    { jobs: jobs.map((j) => j.name) },
    "joburile facturării programate (coada invoices + 2 joburi periodice)",
  );
  return {
    worker,
    queue,
    jobs,
    async close() {
      for (const job of jobs) job.close();
      await worker.close();
      await queue.close();
      redis.disconnect();
    },
  };
}
