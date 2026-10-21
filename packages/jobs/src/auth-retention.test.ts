import { afterEach, describe, expect, it, vi } from "vitest";
import { startAuthRetention } from "./auth-retention";

/** Retenția conturilor neverificate rulează la pornire (după o scurtă întârziere) și apoi periodic; o eroare nu oprește programul. */

afterEach(() => vi.useRealTimers());

const done = { users: 0, verifications: 0 };

describe("startAuthRetention", () => {
  it("rulează o dată după întârziere, apoi la fiecare interval; close() oprește programul", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ users: 2, verifications: 3 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handle = startAuthRetention({ run, logger, initialDelayMs: 1_000, intervalMs: 10_000 });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith({ users: 2, verifications: 3 }, expect.any(String));
    handle.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("o rulare care eșuează se loghează și programul continuă", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error("baza e jos")).mockResolvedValue(done);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handle = startAuthRetention({ run, logger, initialDelayMs: 100, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it("două rulări nu se suprapun: dacă una încă merge, următoarea se sare", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<typeof done>((resolve) => {
          release = () => resolve(done);
        }),
    );
    const handle = startAuthRetention({
      run,
      logger: { info: vi.fn(), warn: vi.fn() },
      initialDelayMs: 10,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    handle.close();
  });
});
