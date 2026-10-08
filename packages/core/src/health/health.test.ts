import { describe, expect, it } from "vitest";
import { runCheck } from "./checks";
import { summarizeHealth } from "./index";

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
