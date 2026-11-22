import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  CarrierConfigService,
  CarrierRuntime,
  SettingsService,
  createPrismaSettingsStore,
  readDemoGuardEnv,
  syncShipmentStatuses,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Sincronizarea stării expedierilor (Faza 12): `shipment-status-sync`, la 10 minute DE LA SFÂRȘITUL rulării precedente (două rulări
 * nu se suprapun). Citește urmărirea curierului pentru expedierile prin API încă deschise, scrie evenimentele (idempotent, cu
 * cheie unică) și trece comanda în «expediată» / «livrată» prin state machine; emailurile pleacă din outbox, o singură dată pe
 * eveniment. O urmărire care eșuează (curier picat, întrerupător deschis) nu le oprește pe celelalte și se reîncearcă la rularea
 * următoare (reîncercare = următorul ciclu). Sigur la mai multe instanțe: fiecare comandă se blochează `FOR UPDATE` și starea nu
 * coboară. Același tipar ca celelalte joburi periodice ale proiectului (nu o coadă BullMQ: nu există nimic de distribuit).
 */
export const SHIPPING_JOB_SCHEDULE = { everyMs: 600_000 } as const;

export interface ShippingJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

export function startShippingJobsFromEnv(): ShippingJobsHandle {
  const env = loadEnv();
  const db = getDb();
  const logger: PeriodicJobLogger = getLogger();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const config = new CarrierConfigService({
    db,
    appKey: env.APP_KEY,
    env: readDemoGuardEnv(),
    readSelected: async () => (await settings.getGroup("shipping")).carrier,
  });
  const runtime = new CarrierRuntime({
    source: config,
    readCacheSeconds: async () => (await settings.getGroup("shipping")).rateCacheSeconds,
  });
  const job = startPeriodicJob({
    name: "shipment-status-sync",
    schedule: SHIPPING_JOB_SCHEDULE,
    run: () =>
      syncShipmentStatuses(db, (provider) => runtime.carrier(provider), { now: new Date() }),
    summarize: (r) => (r.checked === 0 && r.failed === 0 ? null : r),
    logger,
    initialDelayMs: 90_000,
  });
  logger.info(
    { job: "shipment-status-sync", everyMs: SHIPPING_JOB_SCHEDULE.everyMs },
    "jobul de sincronizare a stării expedierilor programat",
  );
  return {
    jobs: [job],
    close() {
      job.close();
      redis.disconnect();
    },
  };
}
