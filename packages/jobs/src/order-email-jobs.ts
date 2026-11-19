import { sweepDispatches } from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { createEmailQueue, enqueueOrderEmail, type EmailQueue } from "./queues";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Măturătorul emailurilor de comenzi (Faza 11), la 10 secunde: pune în coada «emails» rândurile `EmailDispatch` rămase
 * `queued` (rândul se scrie în tranzacția evenimentului, iar coada se alimentează de aici: niciun email nu pleacă dintr-o
 * tranzacție) și marchează `failed` trimiterile rămase «în aer» (NU le retrimite: ar putea fi deja trimise). Idempotent și sigur
 * la mai multe instanțe: `jobId`-ul din coadă deduplică, iar trimiterea se revendică atomic în bază.
 */
export const ORDER_EMAIL_JOB_SCHEDULE = { everyMs: 10_000 } as const;
/** Un rând mai tânăr de atât nu se pune încă în coadă (tranzacția care l-a scris abia s-a încheiat). */
export const ORDER_EMAIL_MIN_AGE_MS = 2_000;
/** O trimitere «sending» mai veche de atât, fără rezultat, e considerată rămasă în aer. */
export const ORDER_EMAIL_STALE_SENDING_MS = 15 * 60_000;
const BATCH = 200;

export interface OrderEmailJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): Promise<void>;
}

export function startOrderEmailJobsFromEnv(): OrderEmailJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const logger: PeriodicJobLogger = getLogger();
  let queue: EmailQueue | null = null;
  const getQueue = (): EmailQueue => {
    if (!queue) {
      queue = createEmailQueue(env.REDIS_URL);
      queue.on("error", () => undefined);
    }
    return queue;
  };
  const job = startPeriodicJob({
    name: "order-email-sweep",
    schedule: ORDER_EMAIL_JOB_SCHEDULE,
    run: async () => {
      const swept = await sweepDispatches(db, {
        now: new Date(),
        minAgeMs: ORDER_EMAIL_MIN_AGE_MS,
        staleSendingMs: ORDER_EMAIL_STALE_SENDING_MS,
        limit: BATCH,
      });
      for (const id of swept.dueIds) await enqueueOrderEmail(getQueue(), env.APP_KEY, id);
      return { queued: swept.dueIds.length, staleFailed: swept.staleFailed };
    },
    summarize: (result) => (result.queued === 0 && result.staleFailed === 0 ? null : result),
    logger,
    initialDelayMs: 5_000,
  });
  logger.info(
    { job: "order-email-sweep", everyMs: ORDER_EMAIL_JOB_SCHEDULE.everyMs },
    "măturătorul emailurilor de comenzi programat",
  );
  return {
    jobs: [job],
    async close() {
      job.close();
      await queue?.close();
    },
  };
}
