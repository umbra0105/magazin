import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  PaymentConfigService,
  SettingsService,
  createPrismaSettingsStore,
  createSystemPaymentAudit,
  expireDueCardOrders,
  processPaymentEvent,
  readDemoGuardEnv,
  reconcilePayments,
  sweepPaymentEvents,
  sweepRefunds,
  type PaymentProcessorDeps,
  type RefundDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import type { Worker } from "bullmq";
import { startPaymentWorker, type PaymentEventJob } from "./payment-queue";
import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from "./periodic-job";

/**
 * Joburile plăților (Faza 10), toate idempotente și sigure la mai multe instanțe:
 *  - `payment-events` (BullMQ): procesează notificările înregistrate de ruta webhook, cu reîncercări cu backoff;
 *  - `payment-events-sweep` (60 s): măturător de siguranță pentru evenimentele rămase «received» (coadă indisponibilă) sau
 *    «failed» cu încercări rămase; cele care au epuizat încercările rămân «failed» = dead-letter vizibil în admin;
 *  - `payment-refunds-sweep` (60 s): trimite cererile de rambursare rămase netrimise și trece în «manuală» pe cele trimise și
 *    neconfirmate (fără retrimitere);
 *  - `order-expire-card` (60 s): anulează comenzile cu card după fereastra de reîncercare;
 *  - `payment-reconcile` (zilnic, 03:30 ora magazinului): compară plățile în așteptare cu procesatorul.
 */
export const PAYMENT_JOB_SCHEDULES = {
  eventsSweep: { everyMs: 60_000 },
  refundsSweep: { everyMs: 60_000 },
  expireCard: { everyMs: 60_000 },
  reconcileDailyAt: "03:30",
} as const;

export interface PaymentJobsHandle {
  worker: Worker<PaymentEventJob>;
  jobs: PeriodicJobHandle[];
  close(): Promise<void>;
}

export function createPaymentProcessorDeps(): {
  deps: PaymentProcessorDeps;
  config: PaymentConfigService;
  refundDeps: RefundDeps;
  settings: SettingsService;
  redis: Redis;
} {
  const env = loadEnv();
  const db = getDb();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const config = new PaymentConfigService({
    db,
    appKey: env.APP_KEY,
    env: readDemoGuardEnv(),
    readCardProvider: async () => (await settings.getGroup("payment")).cardProvider,
  });
  const getProvider = (code: string) => config.getProvider(code);
  const now = () => new Date();
  const deps: PaymentProcessorDeps = {
    db,
    getProvider,
    now,
    markVerifiedInSandbox: (code) => config.markVerifiedInSandbox(code),
    audit: createSystemPaymentAudit(db),
  };
  return { deps, config, refundDeps: { db, getProvider, now }, settings, redis };
}

export function startPaymentJobsFromEnv(): PaymentJobsHandle {
  const env = loadEnv();
  const logger: PeriodicJobLogger = getLogger();
  const runtime = createPaymentProcessorDeps();
  const { deps, refundDeps, settings, redis } = runtime;
  const db = getDb();

  const worker = startPaymentWorker({
    redisUrl: env.REDIS_URL,
    logger: getLogger(),
    process: async (eventId) => {
      await processPaymentEvent(deps, eventId);
    },
  });

  const jobs: PeriodicJobHandle[] = [
    startPeriodicJob({
      name: "payment-events-sweep",
      schedule: PAYMENT_JOB_SCHEDULES.eventsSweep,
      run: () => sweepPaymentEvents(deps, { olderThanMs: 30_000 }),
      summarize: (r) => (r.processed === 0 && r.failed === 0 ? null : r),
      logger,
      initialDelayMs: 45_000,
    }),
    startPeriodicJob({
      name: "payment-refunds-sweep",
      schedule: PAYMENT_JOB_SCHEDULES.refundsSweep,
      run: () => sweepRefunds(refundDeps, { staleMs: 24 * 3_600_000, unsentAfterMs: 120_000 }),
      summarize: (r) => (r.sent === 0 && r.escalated === 0 ? null : r),
      logger,
      initialDelayMs: 50_000,
    }),
    startPeriodicJob({
      name: "order-expire-card",
      schedule: PAYMENT_JOB_SCHEDULES.expireCard,
      run: () => expireDueCardOrders(db, { now: new Date() }),
      summarize: (r) => (r.cancelled === 0 && r.failed === 0 && !r.more ? null : r),
      logger,
      initialDelayMs: 40_000,
    }),
    startPeriodicJob({
      name: "payment-reconcile",
      schedule: async () => ({
        dailyAt: PAYMENT_JOB_SCHEDULES.reconcileDailyAt,
        timeZone: (await settings.getGroup("regional")).timezone,
      }),
      run: () => reconcilePayments(deps, { minAgeMs: 60 * 60_000, maxAgeMs: 72 * 3_600_000 }),
      summarize: (r) =>
        r.checked === 0 && r.mismatches.length === 0
          ? null
          : { ...r, mismatches: r.mismatches.length },
      logger,
    }),
  ];
  logger.info(
    { jobs: jobs.map((j) => j.name) },
    "joburile plăților programate (coada payment-events + 4 joburi periodice)",
  );
  return {
    worker,
    jobs,
    async close() {
      for (const job of jobs) job.close();
      await worker.close();
      redis.disconnect();
    },
  };
}
