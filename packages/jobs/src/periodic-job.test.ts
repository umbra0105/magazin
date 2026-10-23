import { afterEach, describe, expect, it, vi } from "vitest";
import { startPeriodicJob } from "./periodic-job";

/**
 * Programatorul comun al joburilor periodice (stoc: expirare, prospețimea pozei, curățare): interval sau oră fixă, fără
 * suprapunere, o eroare nu oprește programul, `close()` oprește tot.
 */

afterEach(() => vi.useRealTimers());

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

describe("interval", () => {
  it("prima rulare după întârziere, apoi la fiecare interval de la SFÂRȘITUL rulării precedente", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    const run = vi.fn(async () => ({ expired: 0 }));
    const job = startPeriodicJob({
      name: "test",
      schedule: { everyMs: 60_000 },
      initialDelayMs: 5_000,
      run,
      logger: logger(),
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(run).toHaveBeenCalledTimes(5);
    job.close();
  });

  it("nu se suprapune niciodată: o rulare lungă amână următoarea, nu pornește a doua în paralel", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 150_000)); // mai lungă decât intervalul
      active--;
      return null;
    });
    const job = startPeriodicJob({
      name: "lent",
      schedule: { everyMs: 60_000 },
      initialDelayMs: 0,
      run,
      logger: logger(),
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(maxActive).toBe(1);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    job.close();
  });

  it("close() oprește tot, și o rulare în curs nu mai reprogramează", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    const job = startPeriodicJob({
      name: "x",
      schedule: { everyMs: 1_000 },
      initialDelayMs: 0,
      run,
      logger: logger(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    job.close();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    // close() de două ori e inofensiv
    job.close();
  });
});

describe("erori și raportare", () => {
  it("o rulare care eșuează se loghează (fără stivă în clar) și programul continuă; contorul de eșecuri se resetează la succes", async () => {
    vi.useFakeTimers();
    const log = logger();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("baza e jos"))
      .mockRejectedValueOnce(new Error("baza e jos"))
      .mockResolvedValue({ expired: 3 });
    const job = startPeriodicJob({
      name: "expirare",
      schedule: { everyMs: 1_000 },
      initialDelayMs: 0,
      run,
      logger: log,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({
      job: "expirare",
      consecutiveFailures: 1,
      err: "baza e jos",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.warn.mock.calls[1]?.[0]).toMatchObject({ consecutiveFailures: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(job.stats()).toMatchObject({
      runs: 3,
      failures: 2,
      consecutiveFailures: 0,
      lastError: null,
    });
    job.close();
  });

  it("raportează la nivel info doar rulările cu efect (summarize întoarce un obiect); celelalte la debug", async () => {
    vi.useFakeTimers();
    const log = logger();
    const run = vi.fn().mockResolvedValueOnce({ expired: 0 }).mockResolvedValueOnce({ expired: 4 });
    const job = startPeriodicJob({
      name: "expirare",
      schedule: { everyMs: 1_000 },
      initialDelayMs: 0,
      run,
      summarize: (result: { expired: number }) =>
        result.expired > 0 ? { expired: result.expired } : null,
      logger: log,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toEqual({ job: "expirare", expired: 4 });
    job.close();
  });

  it("stats(): ultima rulare și numărul de rulări, pentru verificări din exterior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    const job = startPeriodicJob({
      name: "s",
      schedule: { everyMs: 1_000 },
      initialDelayMs: 0,
      run: async () => null,
      logger: logger(),
    });
    expect(job.stats()).toMatchObject({ runs: 0, lastRunAt: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(job.stats().runs).toBe(1);
    expect(job.stats().lastRunAt?.toISOString()).toBe("2026-10-23T10:00:00.000Z");
    job.close();
  });
});

describe("oră fixă (zilnic)", () => {
  it("rulează la 03:30 ora locală, în fiecare zi, și rămâne la 03:30 locală peste schimbarea orei", async () => {
    vi.useFakeTimers();
    // vineri 2026-10-23 10:00 UTC; 03:30 la București (vară, UTC+3) = 00:30 UTC
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    const times: string[] = [];
    const job = startPeriodicJob({
      name: "curățare",
      schedule: { dailyAt: "03:30", timeZone: "Europe/Bucharest" },
      run: async () => {
        times.push(new Date().toISOString());
        return null;
      },
      logger: logger(),
    });
    await vi.advanceTimersByTimeAsync(4 * 24 * 3600 * 1000);
    expect(times).toEqual([
      "2026-10-24T00:30:00.000Z", // sâmbătă 03:30 EEST
      "2026-10-25T00:30:00.000Z", // duminică, prima 03:30 (ora repetată)
      "2026-10-26T01:30:00.000Z", // luni 03:30 EET (după trecerea la ora de iarnă)
      "2026-10-27T01:30:00.000Z", // marți
    ]);
    job.close();
  });

  it("programul se citește din nou după fiecare rulare (fusul orar schimbat din setări se aplică)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    let zone = "UTC";
    const times: string[] = [];
    const job = startPeriodicJob({
      name: "curățare",
      schedule: () => ({ dailyAt: "03:30", timeZone: zone }),
      run: async () => {
        times.push(new Date().toISOString());
        zone = "Europe/Bucharest";
        return null;
      },
      logger: logger(),
    });
    await vi.advanceTimersByTimeAsync(3 * 24 * 3600 * 1000);
    expect(times).toEqual([
      "2026-07-01T03:30:00.000Z", // UTC
      "2026-07-02T00:30:00.000Z", // după schimbare: 03:30 la București
      "2026-07-03T00:30:00.000Z",
    ]);
    job.close();
  });

  it("un program invalid (fus necunoscut) nu pornește și nu rulează în gol: se loghează și se reîncearcă peste o oră", async () => {
    vi.useFakeTimers();
    const log = logger();
    const run = vi.fn(async () => null);
    const job = startPeriodicJob({
      name: "greșit",
      schedule: { dailyAt: "03:30", timeZone: "Marte/Olympus" },
      run,
      logger: log,
    });
    await vi.advanceTimersByTimeAsync(3_600_000 * 3);
    expect(run).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(3);
    job.close();
  });
});
