import { expireDueTransferOrders } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Joburile comenzilor (Faza 9): `order-expire-transfers`, la 60 de secunde. Anulează AUTOMAT comenzile cu transfer bancar al căror
 * termen de rezervare a trecut fără plată (tranziție validată, `OrderEvent`, eliberarea rezervării de stoc). De sistem,
 * idempotentă, sigură la mai multe instanțe (fiecare comandă se blochează și se re-verifică). Rezervările expirate le eliberează
 * oricum `stock-expire-reservations`; acest job închide și COMANDA, nu doar stocul.
 */
export const ORDER_JOB_SCHEDULES = { expireTransfers: { everyMs: 60_000 } } as const;

export interface OrderJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startOrderJobsFromEnv(): OrderJobsHandle {
  const db = getDb();
  const logger: PeriodicJobLogger = getLogger();
  const job = startPeriodicJob({
    name: "order-expire-transfers",
    schedule: ORDER_JOB_SCHEDULES.expireTransfers,
    run: () => expireDueTransferOrders(db, { now: new Date() }),
    summarize: (result) =>
      result.cancelled === 0 && result.failed === 0 && !result.more
        ? null
        : { cancelled: result.cancelled, failed: result.failed, more: result.more },
    logger,
    initialDelayMs: 30_000,
  });
  logger.info(
    { job: "order-expire-transfers", everyMs: ORDER_JOB_SCHEDULES.expireTransfers.everyMs },
    "jobul de anulare a transferurilor expirate programat",
  );
  return { jobs: [job], close: () => job.close() };
}
