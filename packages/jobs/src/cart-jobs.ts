import { loadEnv } from "@ecom/config";
import { SettingsService, createPrismaSettingsStore, purgeExpiredCarts } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Curățarea coșurilor expirate (Faza 8; docs/04, «curățare sesiuni, coșuri și token-uri expirate»): `cart-purge-expired`, zilnic
 * la 04:00 (ora magazinului). Șterge coșurile al căror termen a trecut, cu liniile lor (cascadă). De sistem, idempotentă, sigură
 * la mai multe instanțe. Fiecare modificare a unui coș îi prelungește termenul, deci un coș activ nu se șterge.
 */
export const CART_JOB_SCHEDULE = { dailyAt: "04:00" } as const;

export interface CartJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startCartJobsFromEnv(): CartJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe baza de date
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const logger: PeriodicJobLogger = getLogger();
  const job = startPeriodicJob({
    name: "cart-purge-expired",
    schedule: async () => ({
      dailyAt: CART_JOB_SCHEDULE.dailyAt,
      timeZone: (await settings.getGroup("regional")).timezone,
    }),
    run: async () => ({ purged: await purgeExpiredCarts(db, new Date()) }),
    summarize: (result) => {
      const purged = (result as { purged: number }).purged;
      return purged === 0 ? null : { purged };
    },
    logger,
    initialDelayMs: 90_000,
  });
  logger.info(
    { job: "cart-purge-expired", dailyAt: CART_JOB_SCHEDULE.dailyAt },
    "jobul de curățare a coșurilor programat",
  );
  return {
    jobs: [job],
    close() {
      job.close();
      redis.disconnect();
    },
  };
}
