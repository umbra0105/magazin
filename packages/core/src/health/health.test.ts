import { beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "./checks";
import { checkHealth, summarizeHealth } from "./index";

describe("runCheck", () => {
  it("raportează ok când proba reușește", async () => {
    const result = await runCheck(async () => undefined);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("transformă o excepție în rezultat eșuat, fără să arunce", async () => {
    const result = await runCheck(async () => {
      throw new Error("conexiune refuzată");
    });
    expect(result).toMatchObject({ ok: false, error: "conexiune refuzată" });
  });

  it("eșuează la timeout", async () => {
    const result = await runCheck(() => new Promise<void>(() => undefined), 50);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });
});

describe("summarizeHealth", () => {
  const ok = { ok: true, latencyMs: 1 };
  const fail = { ok: false, latencyMs: 1, error: "x" };

  it("este ok doar dacă toate verificările trec", () => {
    expect(summarizeHealth({ database: ok, redis: ok }).status).toBe("ok");
    expect(summarizeHealth({ database: ok, redis: fail }).status).toBe("degraded");
    expect(summarizeHealth({ database: fail, redis: ok }).status).toBe("degraded");
  });
});

/**
 * Blocul C, C-09: `/api/health` e public și deschidea o conexiune Postgres și una Redis la FIECARE cerere, fără limită:
 * câteva sute de cereri paralele epuizau `max_connections`. Acum verificările se rulează cel mult o dată pe fereastră,
 * iar cererile simultane așteaptă aceeași verificare.
 */
describe("checkHealth: o singură verificare pe fereastră", () => {
  // fiecare test are adrese proprii: memoria de rezultate e pe pereche de adrese
  let counter = 0;
  let deps = { databaseUrl: "", redisUrl: "" };
  beforeEach(() => {
    counter++;
    deps = { databaseUrl: `postgresql://x/db-${counter}`, redisUrl: `redis://x/${counter}` };
  });
  const makeProbes = () => {
    const calls = { database: 0, redis: 0 };
    return {
      calls,
      probes: {
        database: async () => {
          calls.database++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, latencyMs: 20 };
        },
        redis: async () => {
          calls.redis++;
          return { ok: true, latencyMs: 1 };
        },
      },
    };
  };

  it("300 de cereri simultane deschid o singură conexiune pe dependență", async () => {
    const { calls, probes } = makeProbes();
    const reports = await Promise.all(
      Array.from({ length: 300 }, () => checkHealth(deps, { probes, ttlMs: 5_000 })),
    );
    expect(calls).toEqual({ database: 1, redis: 1 });
    expect(new Set(reports.map((r) => r.status))).toEqual(new Set(["ok"]));
  });

  it("în fereastră se întoarce rezultatul memorat; după fereastră se reia verificarea", async () => {
    const { calls, probes } = makeProbes();
    let now = 1_000;
    const options = { probes, ttlMs: 5_000, now: () => now };
    await checkHealth(deps, options);
    now += 4_000;
    await checkHealth(deps, options);
    expect(calls.database).toBe(1);
    now += 2_000;
    await checkHealth(deps, options);
    expect(calls.database).toBe(2);
  });

  it("un rezultat degradat se memorează mai scurt, ca revenirea să se vadă repede", async () => {
    let healthy = false;
    let now = 0;
    const probes = {
      database: async () => ({ ok: healthy, latencyMs: 1, ...(healthy ? {} : { error: "x" }) }),
      redis: async () => ({ ok: true, latencyMs: 1 }),
    };
    const options = { probes, ttlMs: 5_000, degradedTtlMs: 1_000, now: () => now };
    expect((await checkHealth(deps, options)).status).toBe("degraded");
    healthy = true;
    now += 1_500;
    expect((await checkHealth(deps, options)).status).toBe("ok");
  });

  it("dependențe diferite nu împart memoria", async () => {
    const a = makeProbes();
    const b = makeProbes();
    await checkHealth(deps, { probes: a.probes, ttlMs: 5_000 });
    await checkHealth(
      { databaseUrl: "postgresql://x/db-b", redisUrl: "redis://x/b" },
      { probes: b.probes, ttlMs: 5_000 },
    );
    expect(a.calls.database + b.calls.database).toBe(2);
  });
});
