import { loadEnv } from "@ecom/config";
import {
  AuditService,
  SettingsService,
  StockMaintenance,
  createPrismaAuditStore,
  createPrismaSettingsStore,
  type CheckSnapshotFreshnessResult,
  type ExpireReservationsResult,
  type PurgeBackInStockResult,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";
import { createBackInStockService } from "./back-in-stock-runtime";
import { createEmailQueue, enqueueBackInStock } from "./queues";
import {
  startPeriodicJob,
  type JobSchedule,
  type PeriodicJobHandle,
  type PeriodicJobLogger,
  type ScheduleSource,
} from "./periodic-job";

/**
 * Joburile de stoc (Faza 5, punctul 7) și programul lor (valorile din plan):
 *
 * | job                         | când                           | ce face                                                     |
 * |-----------------------------|--------------------------------|-------------------------------------------------------------|
 * | `stock-expire-reservations` | la 60 de secunde               | eliberează rezervările cu termenul trecut (card, transfer)   |
 * | `stock-back-in-stock`      | la 60 de secunde               | pune în coadă emailul «Anunță-mă» al variantelor revenite    |
 * | `stock-snapshot-freshness`  | la 15 minute                   | alertă în audit când poza SmartBill e veche; memento la 24 h |
 * | `stock-alerts-cleanup`      | zilnic la 03:30, ora magazinului | șterge cererile «Anunță-mă» vechi (GDPR)                    |
 *
 * Toate sunt de sistem (fără utilizator, deci nimic de reverificat la permisiuni), idempotente și sigure la mai multe
 * instanțe. Setările (pragul pozei, retenția, fusul orar) se citesc din nou la FIECARE rulare, nu o dată la pornire.
 */

export const STOCK_JOB_SCHEDULES = {
  expireReservations: { everyMs: 60_000 },
  backInStock: { everyMs: 60_000 },
  snapshotFreshness: { everyMs: 15 * 60_000 },
  cleanup: { dailyAt: "03:30" },
} as const;

export type StockJobName =
  | "stock-expire-reservations"
  | "stock-snapshot-freshness"
  | "stock-alerts-cleanup"
  | "stock-back-in-stock";

/** Câte cereri «Anunță-mă» se pun în coadă la o rulare (restul urmează la rularea următoare, la 60 de secunde) */
export const BACK_IN_STOCK_BATCH = 200;

export interface BackInStockDispatchResult {
  /** câte cereri ale unor variante revenite în stoc a găsit selecția */
  found: number;
  enqueued: number;
  /** puse în coadă fără succes (Redis indisponibil); se reiau la rularea următoare */
  failed: number;
}

/** Ce rulează jobul `stock-back-in-stock` (și ce se înlocuiește în teste). */
export interface BackInStockDispatcher {
  dispatch(): Promise<BackInStockDispatchResult>;
}

/**
 * Găsește cererile ale căror variante au revenit în stoc și le pune în coadă, câte un job pe cerere (doar identificatorul).
 * Nu ia cererile: `claim` se face în procesor, imediat înainte de trimitere. O cerere deja în coadă nu se dublează
 * (`jobId` derivat din cerere), așa că rularea simultană a mai multor instanțe e sigură.
 */
export function createBackInStockDispatcher(deps: {
  service: { findNotifiable(options: { limit: number }): Promise<Array<{ id: string }>> };
  enqueue(alertId: string): Promise<void>;
}): BackInStockDispatcher {
  return {
    async dispatch() {
      const alerts = await deps.service.findNotifiable({ limit: BACK_IN_STOCK_BATCH });
      let enqueued = 0;
      let failed = 0;
      for (const alert of alerts) {
        try {
          await deps.enqueue(alert.id);
          enqueued += 1;
        } catch {
          failed += 1;
        }
      }
      return { found: alerts.length, enqueued, failed };
    },
  };
}

/** Ce îi trebuie joburilor de la `StockMaintenance` (și ce se înlocuiește în teste). */
export interface StockJobsMaintenance {
  expireReservations(): Promise<ExpireReservationsResult>;
  checkSnapshotFreshness(options: {
    staleHours: number;
  }): Promise<
    Pick<
      CheckSnapshotFreshnessResult,
      "checked" | "alerts" | "recoveries" | "reminders" | "skipped"
    >
  >;
  purgeBackInStockAlerts(options: { retentionDays: number }): Promise<PurgeBackInStockResult>;
}

export interface StockJobsSettings {
  snapshotStaleHours: number;
  backInStockRetentionDays: number;
  timeZone: string;
}

export interface StockJobDefinition {
  name: StockJobName;
  schedule: ScheduleSource;
  run: () => Promise<unknown>;
  summarize?: (result: unknown) => object | null;
}

export interface BuildStockJobsOptions {
  maintenance: StockJobsMaintenance;
  backInStock: BackInStockDispatcher;
  readSettings: () => Promise<StockJobsSettings>;
  logger: PeriodicJobLogger;
}

export function buildStockJobs(options: BuildStockJobsOptions): StockJobDefinition[] {
  const { maintenance, readSettings, backInStock } = options;
  return [
    {
      name: "stock-expire-reservations",
      schedule: STOCK_JOB_SCHEDULES.expireReservations,
      run: () => maintenance.expireReservations(),
      summarize: (result) => {
        const r = result as ExpireReservationsResult;
        return r.expired === 0 && r.complete
          ? null
          : { expired: r.expired, batches: r.batches, complete: r.complete };
      },
    },
    {
      name: "stock-snapshot-freshness",
      schedule: STOCK_JOB_SCHEDULES.snapshotFreshness,
      run: async () => {
        const settings = await readSettings();
        return maintenance.checkSnapshotFreshness({ staleHours: settings.snapshotStaleHours });
      },
      summarize: (result) => {
        const r = result as Awaited<ReturnType<StockJobsMaintenance["checkSnapshotFreshness"]>>;
        if (r.alerts + r.recoveries + r.reminders === 0) return null;
        return {
          checked: r.checked,
          alerts: r.alerts,
          recoveries: r.recoveries,
          reminders: r.reminders,
        };
      },
    },
    {
      name: "stock-alerts-cleanup",
      schedule: async (): Promise<JobSchedule> => ({
        dailyAt: STOCK_JOB_SCHEDULES.cleanup.dailyAt,
        timeZone: (await readSettings()).timeZone,
      }),
      run: async () => {
        const settings = await readSettings();
        return maintenance.purgeBackInStockAlerts({
          retentionDays: settings.backInStockRetentionDays,
        });
      },
      summarize: (result) => {
        const r = result as PurgeBackInStockResult;
        return r.unsent + r.sent === 0 ? null : { unsent: r.unsent, sent: r.sent };
      },
    },
    {
      name: "stock-back-in-stock",
      schedule: STOCK_JOB_SCHEDULES.backInStock,
      run: () => backInStock.dispatch(),
      summarize: (result) => {
        const r = result as BackInStockDispatchResult;
        return r.found === 0 ? null : { found: r.found, enqueued: r.enqueued, failed: r.failed };
      },
    },
  ];
}

export interface StockJobsHandle {
  jobs: PeriodicJobHandle[];
  close(): void;
}

/** Pornește joburile date. Prima rulare a celor la interval vine după `initialDelayMs` (implicit 30 s: nu încarcă pornirea). */
export function startStockJobs(
  definitions: readonly StockJobDefinition[],
  options: { logger: PeriodicJobLogger; initialDelayMs?: number },
): StockJobsHandle {
  const jobs = definitions.map((definition) =>
    startPeriodicJob({
      name: definition.name,
      schedule: definition.schedule,
      run: definition.run,
      ...(definition.summarize && { summarize: definition.summarize }),
      logger: options.logger,
      initialDelayMs: options.initialDelayMs ?? 30_000,
    }),
  );
  return {
    jobs,
    close() {
      for (const job of jobs) job.close();
    },
  };
}

/** Dependențele reale (baza de date, setările, jurnalul de audit); folosit de `pnpm worker`, de workerul de dezvoltare și de scripturi. */
export function createStockJobsFromEnv() {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe baza de date
  const db = getDb();
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const maintenance = new StockMaintenance({
    db,
    audit: new AuditService(createPrismaAuditStore(db)),
  });
  const emailQueue = createEmailQueue(env.REDIS_URL);
  emailQueue.on("error", () => undefined); // o pierdere de conexiune nu oprește procesul; următoarea rulare reîncearcă
  const backInStock = createBackInStockDispatcher({
    service: createBackInStockService(db, settings),
    enqueue: (alertId) => enqueueBackInStock(emailQueue, env.APP_KEY, alertId),
  });
  const readSettings = async (): Promise<StockJobsSettings> => {
    const [inventory, regional] = await Promise.all([
      settings.getGroup("inventory"),
      settings.getGroup("regional"),
    ]);
    return {
      snapshotStaleHours: inventory.snapshotStaleHours,
      backInStockRetentionDays: inventory.backInStockRetentionDays,
      timeZone: regional.timezone,
    };
  };
  const logger = getLogger();
  return {
    maintenance,
    readSettings,
    definitions: buildStockJobs({ maintenance, readSettings, backInStock, logger }),
    logger,
    close() {
      redis.disconnect();
      void emailQueue.close();
    },
  };
}

export function startStockJobsFromEnv(): StockJobsHandle {
  const real = createStockJobsFromEnv();
  const handle = startStockJobs(real.definitions, { logger: real.logger });
  real.logger.info(
    {
      jobs: real.definitions.map((d) => d.name),
      expireEveryMs: STOCK_JOB_SCHEDULES.expireReservations.everyMs,
      backInStockEveryMs: STOCK_JOB_SCHEDULES.backInStock.everyMs,
      snapshotCheckEveryMs: STOCK_JOB_SCHEDULES.snapshotFreshness.everyMs,
      cleanupDailyAt: STOCK_JOB_SCHEDULES.cleanup.dailyAt,
    },
    "joburile de stoc programate",
  );
  return {
    jobs: handle.jobs,
    close() {
      handle.close();
      real.close();
    },
  };
}
