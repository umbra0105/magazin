import { expireDueOffers } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Expirarea ofertelor de plată (Faza 11): `offer-expire`, la 5 minute. Ofertele active cu termenul trecut devin «expired»
 * (cu eveniment). Nu e singura apărare: o ofertă cu termenul trecut nu se poate plăti nici înainte de rularea jobului (verificarea
 * e și la plată). De sistem, idempotentă, sigură la mai multe instanțe.
 */
export const OFFER_JOB_SCHEDULE = { everyMs: 300_000 } as const;

export interface OfferJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startOfferJobsFromEnv(): OfferJobsHandle {
  const db = getDb();
  const logger: PeriodicJobLogger = getLogger();
  const job = startPeriodicJob({
    name: "offer-expire",
    schedule: OFFER_JOB_SCHEDULE,
    run: async () => ({ expired: await expireDueOffers(db, new Date()) }),
    summarize: (result) => {
      const expired = (result as { expired: number }).expired;
      return expired === 0 ? null : { expired };
    },
    logger,
    initialDelayMs: 60_000,
  });
  logger.info(
    { job: "offer-expire", everyMs: OFFER_JOB_SCHEDULE.everyMs },
    "jobul de expirare a ofertelor programat",
  );
  return {
    jobs: [job],
    close() {
      job.close();
    },
  };
}
