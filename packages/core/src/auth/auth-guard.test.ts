import { describe, expect, it } from "vitest";
import { authSettings } from "../test-utils/auth-settings";
import { AuthGuard, RateLimitedError } from "./auth-guard";
import { MemoryCounterStore } from "./counter-store";

function setup(overrides = {}) {
  return { guard: new AuthGuard(new MemoryCounterStore(), authSettings(overrides)) };
}

describe("AuthGuard", () => {
  it("permite 5 încercări de login pe IP+email, a 6-a primește RateLimitedError cu Retry-After", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.checkLogin("a@x.test", "203.0.113.7");
    const err = await guard.checkLogin("a@x.test", "203.0.113.7").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it("emailul e normalizat: majusculele și spațiile nu ocolesc limita", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.checkLogin(i % 2 ? "A@X.test " : "a@x.test", null);
    await expect(guard.checkLogin(" A@x.TEST", null)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("schimbarea IP-ului nu ocolește limita pe email (de 2× limita pe pereche)", async () => {
    const { guard } = setup();
    let blockedAt = 0;
    for (let i = 1; i <= 20; i++) {
      try {
        await guard.checkLogin("a@x.test", `203.0.113.${i}`);
      } catch {
        blockedAt = i;
        break;
      }
    }
    expect(blockedAt).toBe(11);
  });

  it("alt email de pe același IP nu e afectat", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.checkLogin("a@x.test", "1.1.1.1");
    await expect(guard.checkLogin("b@x.test", "1.1.1.1")).resolves.toBeUndefined();
  });

  it("blochează contul exact la a 10-a greșeală; succesul resetează contorul", async () => {
    const { guard } = setup();
    for (let i = 0; i < 9; i++) expect(await guard.recordLoginFailure("a@x.test")).toBe(false);
    expect(await guard.lockRemainingSeconds("a@x.test")).toBe(0);
    await guard.recordLoginSuccess("a@x.test");
    for (let i = 0; i < 9; i++) expect(await guard.recordLoginFailure("a@x.test")).toBe(false);
    expect(await guard.recordLoginFailure("a@x.test")).toBe(true);
    expect(await guard.lockRemainingSeconds("A@x.test")).toBeGreaterThan(0);
    expect(await guard.lockRemainingSeconds("A@x.test")).toBeLessThanOrEqual(15 * 60);
  });

  it("semnalează blocarea o singură dată, nu la fiecare eșec de după prag", async () => {
    const { guard } = setup();
    const results: boolean[] = [];
    for (let i = 0; i < 13; i++) results.push(await guard.recordLoginFailure("a@x.test"));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("un email inexistent se comportă identic cu unul real (contoare doar pe email)", async () => {
    const { guard } = setup();
    for (let i = 0; i < 10; i++) await guard.recordLoginFailure("nu-exista@x.test");
    expect(await guard.lockRemainingSeconds("nu-exista@x.test")).toBeGreaterThan(0);
  });

  it("unlock scoate blocarea și contorul de eșecuri", async () => {
    const { guard } = setup();
    for (let i = 0; i < 10; i++) await guard.recordLoginFailure("a@x.test");
    await guard.unlock("A@x.test");
    expect(await guard.lockRemainingSeconds("a@x.test")).toBe(0);
    for (let i = 0; i < 9; i++) expect(await guard.recordLoginFailure("a@x.test")).toBe(false);
  });

  it("limitele și durata blocării vin din setări", async () => {
    const { guard } = setup({ loginMaxAttempts: 2, lockoutThreshold: 3, lockoutMinutes: 1 });
    await guard.checkLogin("a@x.test", null);
    await guard.checkLogin("a@x.test", null);
    await expect(guard.checkLogin("a@x.test", null)).rejects.toBeInstanceOf(RateLimitedError);
    for (let i = 0; i < 3; i++) await guard.recordLoginFailure("b@x.test");
    expect(await guard.lockRemainingSeconds("b@x.test")).toBeLessThanOrEqual(60);
  });

  it("înregistrarea e limitată pe IP și pe email; fără IP rămâne doar emailul", async () => {
    const { guard } = setup({ registerMaxAttempts: 2 });
    await guard.checkRegister("a@x.test", "1.1.1.1");
    await guard.checkRegister("b@x.test", "1.1.1.1");
    await expect(guard.checkRegister("c@x.test", "1.1.1.1")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // Fără IP de încredere, utilizatori diferiți nu se blochează între ei.
    for (let i = 0; i < 6; i++) await guard.checkRegister(`u${i}@x.test`, null);
  });

  it("resetarea parolei e limitată pe email", async () => {
    const { guard } = setup({ passwordResetMaxAttempts: 2 });
    await guard.checkPasswordReset("a@x.test", null);
    await guard.checkPasswordReset("a@x.test", null);
    await expect(guard.checkPasswordReset("a@x.test", null)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
