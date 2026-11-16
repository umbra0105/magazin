import { loadEnv } from "@ecom/config";
import { SettingsService, createPrismaSettingsStore, snapshotPriceHistory } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";
import { createWorkerRevalidator } from "./revalidate";

/**
 * Jobul zilnic al istoricului de preț (C-18, Omnibus): `price-history-snapshot`, zilnic la 00:10 (ora magazinului), scrie în
 * `PriceHistory` punctul de preț efectiv al fiecărei variante, inclusiv tranzițiile programate (`saleStartsAt` / `saleEndsAt`)
 * dintre rulări, la momentul lor exact. Sigur la mai multe instanțe și idempotent (vezi `snapshotPriceHistory`).
 */
export const PRICE_JOB_SCHEDULE = { dailyAt: "00:10" } as const;

export interface PriceJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startPriceJobsFromEnv(): PriceJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe DB
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const invalidate = createWorkerRevalidator();
  const logger: PeriodicJobLogger = getLogger();
  const snapshot = async () => {
    const result = await snapshotPriceHistory(db, new Date());
    // paginile din cache arată prețul efectiv: o tranziție scrisă înseamnă că un preț afișat s-a putut schimba
    if (result.written > 0) await invalidate(["catalog"]);
    return result;
  };
  const job = startPeriodicJob({
    name: "price-history-snapshot",
    schedule: async () => ({
      dailyAt: PRICE_JOB_SCHEDULE.dailyAt,
      timeZone: (await settings.getGroup("regional")).timezone,
    }),
    run: snapshot,
    summarize: (result) => (result && typeof result === "object" ? (result as object) : null),
    logger,
    initialDelayMs: 60_000,
  });
  // o rulare la pornire (idempotentă): un magazin proaspăt instalat nu așteaptă până în noaptea următoare pentru primul punct
  const first = setTimeout(() => {
    snapshot().catch((error: unknown) =>
      logger.warn({ err: error }, "price-history-snapshot: rularea de pornire a eșuat"),
    );
  }, 60_000);
  logger.info(
    { job: "price-history-snapshot", dailyAt: PRICE_JOB_SCHEDULE.dailyAt },
    "jobul istoricului de preț programat",
  );
  return {
    jobs: [job],
    close() {
      clearTimeout(first);
      job.close();
      redis.disconnect();
    },
  };
}
