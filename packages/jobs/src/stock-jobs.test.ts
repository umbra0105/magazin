import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACK_IN_STOCK_BATCH,
  STOCK_JOB_SCHEDULES,
  buildStockJobs,
  createBackInStockDispatcher,
  startStockJobs,
  type BackInStockDispatcher,
  type BuildStockJobsOptions,
  type StockJobsMaintenance,
  type StockJobsSettings,
} from "./stock-jobs";

/**
 * Joburile de stoc (Faza 5, punctul 7): ce rulează, cât de des, cu ce setări. Serviciul real (baza de date) e în
 * `stock-maintenance.integration.test.ts`; aici îl înlocuim cu unul fals ca să vedem legăturile și programul.
 */

afterEach(() => vi.useRealTimers());

/** Dispecerul «Anunță-mă» al testelor care nu îl privesc: nu găsește nimic */
const idleDispatcher: BackInStockDispatcher = {
  dispatch: async () => ({ found: 0, enqueued: 0, failed: 0 }),
};

const build = (options: Omit<BuildStockJobsOptions, "backInStock">) =>
  buildStockJobs({ ...options, backInStock: idleDispatcher });

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function setup(overrides: Partial<StockJobsSettings> = {}) {
  const maintenance = {
    expireReservations: vi.fn(async () => ({ expired: 0, batches: 1, complete: true })),
    checkSnapshotFreshness: vi.fn(async () => ({
      checked: 1,
      alerts: 0,
      recoveries: 0,
      reminders: 0,
      skipped: false,
    })),
    purgeBackInStockAlerts: vi.fn(async () => ({ unsent: 0, sent: 0 })),
  } satisfies StockJobsMaintenance;
  const state = {
    snapshotStaleHours: 24,
    backInStockRetentionDays: 90,
    timeZone: "Europe/Bucharest",
    ...overrides,
  };
  const settings: StockJobsSettings = {
    snapshotStaleHours: state.snapshotStaleHours,
    backInStockRetentionDays: state.backInStockRetentionDays,
    timeZone: state.timeZone,
  };
  const read = vi.fn(async () => ({ ...state }));
  return { maintenance, state, read, settings, log: logger() };
}

describe("programul joburilor de stoc (valorile din plan)", () => {
  it("expirarea rulează la 60 de secunde, «Anunță-mă» la 60 de secunde, prospețimea pozei la 15 minute, curățarea zilnic la 03:30", () => {
    expect(STOCK_JOB_SCHEDULES.expireReservations).toEqual({ everyMs: 60_000 });
    expect(STOCK_JOB_SCHEDULES.backInStock).toEqual({ everyMs: 60_000 });
    expect(STOCK_JOB_SCHEDULES.snapshotFreshness).toEqual({ everyMs: 15 * 60_000 });
    expect(STOCK_JOB_SCHEDULES.cleanup).toEqual({ dailyAt: "03:30" });
  });

  it("patru joburi, cu nume stabile", async () => {
    const { maintenance, read, log } = setup();
    const jobs = build({ maintenance, readSettings: read, logger: log });
    expect(jobs.map((j) => j.name)).toEqual([
      "stock-expire-reservations",
      "stock-snapshot-freshness",
      "stock-alerts-cleanup",
      "stock-back-in-stock",
    ]);
  });
});

describe("legăturile cu serviciul și cu setările", () => {
  it("expirarea nu cere setări; întoarce rezumat doar când a expirat ceva", async () => {
    const { maintenance, read, log } = setup();
    const [expire] = build({ maintenance, readSettings: read, logger: log });
    const none = await expire!.run();
    expect(maintenance.expireReservations).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(expire!.summarize?.(none)).toBeNull();
    maintenance.expireReservations.mockResolvedValueOnce({
      expired: 7,
      batches: 2,
      complete: true,
    });
    const some = await expire!.run();
    expect(expire!.summarize?.(some)).toEqual({ expired: 7, batches: 2, complete: true });
  });

  it("o expirare întreruptă de plafon (complete = false) se raportează, ca să se vadă că a rămas de făcut", async () => {
    const { maintenance, read, log } = setup();
    maintenance.expireReservations.mockResolvedValueOnce({
      expired: 10000,
      batches: 50,
      complete: false,
    });
    const [expire] = build({ maintenance, readSettings: read, logger: log });
    const result = await expire!.run();
    expect(expire!.summarize?.(result)).toMatchObject({ expired: 10000, complete: false });
  });

  it("prospețimea pozei citește pragul din setări LA FIECARE rulare (schimbat din admin, se aplică imediat)", async () => {
    const { maintenance, read, state, log } = setup();
    const jobs = build({ maintenance, readSettings: read, logger: log });
    const freshness = jobs[1]!;
    await freshness.run();
    expect(maintenance.checkSnapshotFreshness).toHaveBeenLastCalledWith({ staleHours: 24 });
    state.snapshotStaleHours = 6;
    await freshness.run();
    expect(maintenance.checkSnapshotFreshness).toHaveBeenLastCalledWith({ staleHours: 6 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("curățarea citește retenția la fiecare rulare și se programează în fusul din setări", async () => {
    const { maintenance, read, state, log } = setup();
    const jobs = build({ maintenance, readSettings: read, logger: log });
    const cleanup = jobs[2]!;
    await cleanup.run();
    expect(maintenance.purgeBackInStockAlerts).toHaveBeenLastCalledWith({ retentionDays: 90 });
    state.backInStockRetentionDays = 30;
    await cleanup.run();
    expect(maintenance.purgeBackInStockAlerts).toHaveBeenLastCalledWith({ retentionDays: 30 });
    state.timeZone = "UTC";
    expect(await (cleanup.schedule as () => Promise<unknown>)()).toEqual({
      dailyAt: "03:30",
      timeZone: "UTC",
    });
  });

  it("rezumatele spun doar ce s-a întâmplat: alerte noi, refaceri, ștergeri", async () => {
    const { maintenance, read, log } = setup();
    const jobs = build({ maintenance, readSettings: read, logger: log });
    const freshness = jobs[1]!;
    const cleanup = jobs[2]!;
    expect(freshness.summarize?.(await freshness.run())).toBeNull();
    maintenance.checkSnapshotFreshness.mockResolvedValueOnce({
      checked: 2,
      alerts: 1,
      recoveries: 0,
      reminders: 0,
      skipped: false,
    });
    expect(freshness.summarize?.(await freshness.run())).toMatchObject({ alerts: 1 });
    expect(cleanup.summarize?.(await cleanup.run())).toBeNull();
    maintenance.purgeBackInStockAlerts.mockResolvedValueOnce({ unsent: 3, sent: 1 });
    expect(cleanup.summarize?.(await cleanup.run())).toEqual({ unsent: 3, sent: 1 });
  });

  it("o setare nevalidă (prag 0) face rularea să eșueze zgomotos, nu să ruleze cu o valoare ghicită", async () => {
    const { maintenance, read, log } = setup({ snapshotStaleHours: 0 });
    maintenance.checkSnapshotFreshness.mockRejectedValueOnce(
      new RangeError("Pragul «neactualizat» trebuie să fie între 1 și 720 de ore"),
    );
    const jobs = build({ maintenance, readSettings: read, logger: log });
    await expect(jobs[1]!.run()).rejects.toThrow(RangeError);
  });
});

describe("pornirea tuturor joburilor", () => {
  it("fiecare pornește la momentul lui și close() le oprește pe toate; un job care cade nu le oprește pe celelalte", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    const { maintenance, read, log } = setup();
    maintenance.checkSnapshotFreshness.mockRejectedValue(new Error("baza e jos"));
    const handle = startStockJobs(build({ maintenance, readSettings: read, logger: log }), {
      logger: log,
      initialDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maintenance.expireReservations).toHaveBeenCalledTimes(1);
    expect(maintenance.checkSnapshotFreshness).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(maintenance.expireReservations.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(maintenance.checkSnapshotFreshness).toHaveBeenCalledTimes(1);
    handle.close();
    const calls = maintenance.expireReservations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(maintenance.expireReservations.mock.calls.length).toBe(calls);
    expect(handle.jobs.map((j) => j.name)).toHaveLength(4);
  });
});

describe("jobul «Anunță-mă când revine» (stock-back-in-stock)", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `a${i}`, variantId: `v${i}` }));

  function dispatcherWith(found: Array<{ id: string; variantId: string }>) {
    const service = {
      findNotifiable: vi.fn<(o: { limit: number }) => Promise<typeof found>>(async () => found),
    };
    const enqueue = vi.fn<(alertId: string) => Promise<void>>(async () => undefined);
    return { service, enqueue, dispatcher: createBackInStockDispatcher({ service, enqueue }) };
  }

  it("jobul din program cheamă dispecerul și spune doar ce s-a întâmplat (nimic găsit = nicio linie de jurnal)", async () => {
    const { maintenance, read, log } = setup();
    const dispatch = vi.fn(async () => ({ found: 0, enqueued: 0, failed: 0 }));
    const job = buildStockJobs({
      maintenance,
      readSettings: read,
      logger: log,
      backInStock: { dispatch },
    }).find((j) => j.name === "stock-back-in-stock")!;
    expect(job.schedule).toEqual({ everyMs: 60_000 });
    expect(job.summarize?.(await job.run())).toBeNull();
    dispatch.mockResolvedValueOnce({ found: 3, enqueued: 2, failed: 1 });
    expect(job.summarize?.(await job.run())).toEqual({ found: 3, enqueued: 2, failed: 1 });
    expect(read).not.toHaveBeenCalled();
  });

  it("pune în coadă câte o cerere găsită, cu identificatorul ei, și cere cel mult un lot", async () => {
    const { service, enqueue, dispatcher } = dispatcherWith(ids(3));
    expect(await dispatcher.dispatch()).toEqual({ found: 3, enqueued: 3, failed: 0 });
    expect(service.findNotifiable).toHaveBeenCalledWith({ limit: BACK_IN_STOCK_BATCH });
    expect(enqueue.mock.calls.map((c) => c[0])).toEqual(["a0", "a1", "a2"]);
  });

  it("nimic găsit: nimic în coadă", async () => {
    const { enqueue, dispatcher } = dispatcherWith([]);
    expect(await dispatcher.dispatch()).toEqual({ found: 0, enqueued: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("o punere în coadă care eșuează nu le oprește pe celelalte și se numără, fără să arunce", async () => {
    const { enqueue, dispatcher } = dispatcherWith(ids(4));
    enqueue.mockRejectedValueOnce(new Error("Redis nu răspunde"));
    enqueue.mockRejectedValueOnce(new Error("Redis nu răspunde"));
    expect(await dispatcher.dispatch()).toEqual({ found: 4, enqueued: 2, failed: 2 });
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it("dacă selecția cade (baza e jos), eroarea ajunge la jobul periodic, care o jurnalizează și continuă", async () => {
    const service = {
      findNotifiable: vi.fn(async () => {
        throw new Error("baza e jos");
      }),
    };
    const dispatcher = createBackInStockDispatcher({ service, enqueue: async () => undefined });
    await expect(dispatcher.dispatch()).rejects.toThrow("baza e jos");
  });
});
