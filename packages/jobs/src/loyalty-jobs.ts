import { loadEnv } from "@ecom/config";
import {
  LOYALTY_PORTS,
  SettingsService,
  createPrismaSettingsStore,
  expireDuePoints,
  grantDuePoints,
  sendExpiryWarnings,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Joburile punctelor de loialitate (Faza 15b). Toate sunt idempotente, sigure la mai multe instanțe și nu fac nimic cu programul
 * oprit:
 *  - `loyalty-grant`, din oră în oră: acordă punctele comenzilor la care fereastra de retur s-a încheiat;
 *  - `loyalty-expire`, din oră în oră: scade loturile ajunse la termen (nu atinge punctele rezervate în comenzi);
 *  - `loyalty-expiry-warning`, zilnic la 09:00 (ora magazinului): pune în outbox emailul de avertizare, o dată pe lot.
 */
export const LOYALTY_JOB_SCHEDULE = { everyMs: 3_600_000, warningDailyAt: "09:00" } as const;

export interface LoyaltyJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startLoyaltyJobsFromEnv(): LoyaltyJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe baza de date
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const logger: PeriodicJobLogger = getLogger();
  const quiet = <T extends object>(result: T, count: number): T | null =>
    count === 0 ? null : result;
  const jobs = [
    startPeriodicJob({
      name: "loyalty-grant",
      schedule: { everyMs: LOYALTY_JOB_SCHEDULE.everyMs },
      run: () => grantDuePoints(db, { now: new Date(), ports: LOYALTY_PORTS }),
      summarize: (result) => quiet(result, result.granted + result.failed),
      logger,
      initialDelayMs: 90_000,
    }),
    startPeriodicJob({
      name: "loyalty-expire",
      schedule: { everyMs: LOYALTY_JOB_SCHEDULE.everyMs },
      run: () => expireDuePoints(db, { now: new Date() }),
      summarize: (result) => quiet(result, result.lots + result.failed),
      logger,
      initialDelayMs: 150_000,
    }),
    startPeriodicJob({
      name: "loyalty-expiry-warning",
      schedule: async () => ({
        dailyAt: LOYALTY_JOB_SCHEDULE.warningDailyAt,
        timeZone: (await settings.getGroup("regional")).timezone,
      }),
      run: () => sendExpiryWarnings(db, { now: new Date() }),
      summarize: (result) => quiet(result, result.queued + result.failed),
      logger,
    }),
  ];
  logger.info({ jobs: jobs.map((job) => job.name) }, "joburile punctelor de loialitate programate");
  return {
    jobs,
    close() {
      for (const job of jobs) job.close();
      redis.disconnect();
    },
  };
}
