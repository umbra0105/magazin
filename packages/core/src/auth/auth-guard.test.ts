import { describe, expect, it } from "vitest";
import { authSettings } from "../test-utils/auth-settings";
import { AuthGuard, RateLimitedError } from "./auth-guard";
import { MemoryCounterStore } from "./counter-store";

function setup(overrides = {}) {
  return { guard: new AuthGuard(new MemoryCounterStore(), authSettings(overrides)) };
}

describe("AuthGuard", () => {
  it("ritmul de încercări pe adresă: peste limită pe minut → RateLimitedError cu Retry-After; alt IP nu e afectat", async () => {
    const { guard } = setup({ loginRatePerMinutePerIp: 5 });
    for (let i = 0; i < 5; i++) await guard.checkLogin(`u${i}@x.test`, "203.0.113.7");
    const err = await guard.checkLogin("a@x.test", "203.0.113.7").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(60);
    await expect(guard.checkLogin("a@x.test", "203.0.113.8")).resolves.toBeUndefined();
  });

  it("fără IP de încredere ritmul are un coș comun, cu limita de 10 ori mai mare", async () => {
    const { guard } = setup({ loginRatePerMinutePerIp: 2 });
    for (let i = 0; i < 20; i++) await guard.checkLogin(`u${i}@x.test`, null);
    await expect(guard.checkLogin("a@x.test", null)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("perechea (email, IP) se blochează exact la a 5-a greșeală, o singură dată; emailul e normalizat", async () => {
    const { guard } = setup();
    const results: string[][] = [];
    for (let i = 0; i < 7; i++) {
      const locks = await guard.recordLoginFailure(i % 2 ? " A@X.test" : "a@x.test", "1.1.1.1");
      results.push(locks.map((l) => l.kind));
    }
    expect(results.slice(0, 4)).toEqual([[], [], [], []]);
    expect(results[4]).toEqual(["pair"]);
    expect(results.slice(5)).toEqual([[], []]);
    expect(await guard.lockRemainingSeconds("A@x.test", "1.1.1.1")).toBeGreaterThan(0);
    expect(await guard.lockRemainingSeconds("a@x.test", "1.1.1.1")).toBeLessThanOrEqual(15 * 60);
    await expect(guard.checkLogin("a@x.test", "1.1.1.1")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("blocarea perechii nu atinge același email de pe alt IP, nici alt email de pe același IP", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.recordLoginFailure("a@x.test", "1.1.1.1");
    await expect(guard.checkLogin("a@x.test", "1.1.1.2")).resolves.toBeUndefined();
    await expect(guard.checkLogin("b@x.test", "1.1.1.1")).resolves.toBeUndefined();
  });

  it("adresa se blochează la loginIpMaxAttempts eșecuri pe emailuri diferite și blochează toate emailurile de pe ea", async () => {
    const { guard } = setup({ loginIpMaxAttempts: 4 });
    const kinds: string[][] = [];
    for (let i = 0; i < 4; i++) {
      kinds.push((await guard.recordLoginFailure(`u${i}@x.test`, "2.2.2.2")).map((l) => l.kind));
    }
    expect(kinds[3]).toEqual(["ip"]);
    await expect(guard.checkLogin("nou@x.test", "2.2.2.2")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await expect(guard.checkLogin("nou@x.test", "2.2.2.3")).resolves.toBeUndefined();
  });

  it("nu există blocare globală pe email: eșecuri de la multe adrese dau doar o alertă, o singură dată", async () => {
    const { guard } = setup({ lockoutThreshold: 4, loginMaxAttempts: 50, loginIpMaxAttempts: 50 });
    const alerts: number[] = [];
    for (let i = 0; i < 9; i++) {
      const locks = await guard.recordLoginFailure("a@x.test", `10.0.0.${i + 1}`);
      if (locks.some((l) => l.kind === "email_alert")) alerts.push(i + 1);
    }
    expect(alerts).toEqual([4]);
    await expect(guard.checkLogin("a@x.test", "10.0.0.99")).resolves.toBeUndefined();
  });

  it("succesul șterge eșecurile perechii (nu se adună peste conectări reușite)", async () => {
    const { guard } = setup({ lockoutThreshold: 100 }); // alerta pe email nu face parte din acest test
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        expect(await guard.recordLoginFailure("a@x.test", "1.1.1.1")).toEqual([]);
      }
      await guard.recordLoginSuccess("a@x.test", "1.1.1.1");
    }
  });

  it("blocarea e progresivă: baza, apoi dublu, apoi de patru ori; contorul de blocări se resetează la succes", async () => {
    let now = 1_000_000;
    const guard = new AuthGuard(
      new MemoryCounterStore(() => now),
      authSettings({ loginMaxAttempts: 2, lockoutMinutes: 1 }),
    );
    const lockMinutes = async () => {
      let last = 0;
      for (let i = 0; i < 2; i++) {
        const locks = await guard.recordLoginFailure("a@x.test", "1.1.1.1");
        last = locks.find((l) => l.kind === "pair")?.lockoutMinutes ?? last;
      }
      return last;
    };
    expect(await lockMinutes()).toBe(1);
    now += 61_000; // blocarea expiră
    expect(await lockMinutes()).toBe(2);
    now += 121_000;
    expect(await lockMinutes()).toBe(4);
    now += 241_000;
    await guard.recordLoginSuccess("a@x.test", "1.1.1.1");
    expect(await lockMinutes()).toBe(1);
  });

  it("blocarea nu depășește 24 de ore", async () => {
    let now = 1_000_000;
    const guard = new AuthGuard(
      new MemoryCounterStore(() => now),
      authSettings({ loginMaxAttempts: 1, lockoutMinutes: 400 }),
    );
    const minutes: number[] = [];
    // blocările de 400 și 800 de minute expiră, iar contorul de blocări (fereastră de 24 h) rămâne
    for (const wait of [7, 14, 0]) {
      const locks = await guard.recordLoginFailure("a@x.test", "1.1.1.1");
      minutes.push(locks[0]?.lockoutMinutes ?? 0);
      now += wait * 3600_000;
    }
    expect(minutes).toEqual([400, 800, 1440]);
  });

  it("fără IP de încredere: prag ×3, blocare de cel mult un minut, fără blocare pe IP", async () => {
    const { guard } = setup({ loginMaxAttempts: 2, lockoutMinutes: 15 });
    const kinds: string[][] = [];
    for (let i = 0; i < 6; i++) {
      kinds.push((await guard.recordLoginFailure("a@x.test", null)).map((l) => l.kind));
    }
    expect(kinds.slice(0, 5)).toEqual([[], [], [], [], []]);
    expect(kinds[5]).toEqual(["pair"]);
    expect(await guard.lockRemainingSeconds("a@x.test", null)).toBeLessThanOrEqual(60);
  });

  it("un email inexistent se comportă identic cu unul real (contoare doar pe email trimis)", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.recordLoginFailure("nu-exista@x.test", "1.1.1.1");
    expect(await guard.lockRemainingSeconds("nu-exista@x.test", "1.1.1.1")).toBeGreaterThan(0);
  });

  it("unlock scoate blocările și eșecurile de pe TOATE adresele", async () => {
    const { guard } = setup();
    for (const ip of ["1.1.1.1", "2.2.2.2", null]) {
      for (let i = 0; i < 6; i++) await guard.recordLoginFailure("a@x.test", ip);
    }
    await guard.unlock("A@x.test");
    for (const ip of ["1.1.1.1", "2.2.2.2", null]) {
      expect(await guard.lockRemainingSeconds("a@x.test", ip)).toBe(0);
      await expect(guard.checkLogin("a@x.test", ip)).resolves.toBeUndefined();
    }
  });

  it("limitele și durata blocării vin din setări", async () => {
    const { guard } = setup({ loginMaxAttempts: 2, lockoutMinutes: 3 });
    await guard.recordLoginFailure("b@x.test", "1.1.1.1");
    const locks = await guard.recordLoginFailure("b@x.test", "1.1.1.1");
    expect(locks).toEqual([{ kind: "pair", lockoutMinutes: 3 }]);
    expect(await guard.lockRemainingSeconds("b@x.test", "1.1.1.1")).toBeLessThanOrEqual(180);
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

  it("confirmarea emailului: limitată pe IP, alt IP nu e afectat", async () => {
    const { guard } = setup({ verifyEmailMaxAttempts: 3 });
    for (let i = 0; i < 3; i++) await guard.checkVerifyEmail("203.0.113.5");
    const err = await guard.checkVerifyEmail("203.0.113.5").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    await expect(guard.checkVerifyEmail("203.0.113.6")).resolves.toBeUndefined();
  });

  it("confirmarea emailului fără IP de încredere: bucket comun, cu limita de 10 ori mai mare", async () => {
    const { guard } = setup({ verifyEmailMaxAttempts: 2 });
    for (let i = 0; i < 20; i++) await guard.checkVerifyEmail(null);
    await expect(guard.checkVerifyEmail(null)).rejects.toBeInstanceOf(RateLimitedError);
  });
});
