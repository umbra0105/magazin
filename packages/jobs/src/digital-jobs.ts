import { loadEnv } from "@ecom/config";
import { SettingsService, createPrismaSettingsStore, purgeExpiredAccessLogData } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Curățarea jurnalului de accesări digitale (Faza 14b, decizia 9): `digital-access-log-purge`, zilnic la 04:30 (ora magazinului).
 * IP-ul și user-agent-ul rândurilor mai vechi decât `digital.accessLogRetentionDays` devin nule; rândul (fără date personale)
 * rămâne. De sistem, idempotentă, sigură la mai multe instanțe (un `UPDATE` pe rândurile încă neanonimizate).
 */
export const DIGITAL_JOB_SCHEDULE = { dailyAt: "04:30" } as const;

export interface DigitalJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startDigitalJobsFromEnv(): DigitalJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe baza de date
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const logger: PeriodicJobLogger = getLogger();
  const job = startPeriodicJob({
    name: "digital-access-log-purge",
    schedule: async () => ({
      dailyAt: DIGITAL_JOB_SCHEDULE.dailyAt,
      timeZone: (await settings.getGroup("regional")).timezone,
    }),
    run: async () => ({ purged: await purgeExpiredAccessLogData(db, new Date()) }),
    summarize: (result) => {
      const purged = (result as { purged: number }).purged;
      return purged === 0 ? null : { purged };
    },
    logger,
    initialDelayMs: 120_000,
  });
  logger.info(
    { job: "digital-access-log-purge", dailyAt: DIGITAL_JOB_SCHEDULE.dailyAt },
    "jobul de curățare a jurnalului de accesări digitale programat",
  );
  return {
    jobs: [job],
    close() {
      job.close();
      redis.disconnect();
    },
  };
}
