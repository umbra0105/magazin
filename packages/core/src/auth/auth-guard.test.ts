import { describe, expect, it } from "vitest";
import { authSettings } from "../test-utils/auth-settings";
import { AuthGuard, RateLimitedError } from "./auth-guard";
import { ipKey } from "./client-ip";
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

  it("înregistrarea: 20 pe oră pe adresă (implicit), 5 pe oră pe email; a 21-a de pe aceeași adresă primește 429", async () => {
    const { guard } = setup();
    for (let i = 0; i < 20; i++) await guard.checkRegister(`u${i}@x.test`, "1.1.1.1");
    const err = await guard.checkRegister("nou@x.test", "1.1.1.1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    await expect(guard.checkRegister("nou@x.test", "1.1.1.2")).resolves.toBeUndefined();
  });

  it("înregistrarea: același email de la adrese diferite e limitat la 5 pe oră", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.checkRegister("a@x.test", `10.0.0.${i + 1}`);
    await expect(guard.checkRegister("a@x.test", "10.0.0.99")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("limitele de înregistrare vin din setări: registerMaxPerIp (adresă) și registerMaxAttempts (email)", async () => {
    const { guard } = setup({ registerMaxPerIp: 2, registerMaxAttempts: 50 });
    await guard.checkRegister("a@x.test", "1.1.1.1");
    await guard.checkRegister("b@x.test", "1.1.1.1");
    await expect(guard.checkRegister("c@x.test", "1.1.1.1")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("fără IP de încredere există un coș GLOBAL de rezervă (de 10 ori limita pe adresă), nu limită zero", async () => {
    const { guard } = setup({ registerMaxPerIp: 3, registerMaxAttempts: 100 });
    for (let i = 0; i < 30; i++) await guard.checkRegister(`u${i}@x.test`, null);
    await expect(guard.checkRegister("alt@x.test", null)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("IPv6: adrese diferite din același /64 împart limita (cheie /64)", async () => {
    const { guard } = setup({ registerMaxPerIp: 2, registerMaxAttempts: 50 });
    // resolveClientIp întoarce deja cheia /64: două adrese din același /64 ajung la aceeași cheie
    const key = ipKey("2001:db8:1:2::1");
    expect(key).toBe(ipKey("2001:db8:1:2:ffff::9"));
    await guard.checkRegister("a@x.test", key);
    await guard.checkRegister("b@x.test", key);
    await expect(guard.checkRegister("c@x.test", key)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("resetarea parolei: 20 pe adresă, 5 pe email; fără IP, coș global", async () => {
    const { guard } = setup({ passwordResetMaxAttempts: 2, passwordResetMaxPerIp: 3 });
    await guard.checkPasswordReset("a@x.test", "1.1.1.1");
    await guard.checkPasswordReset("a@x.test", "1.1.1.2");
    await expect(guard.checkPasswordReset("a@x.test", "1.1.1.3")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    for (let i = 0; i < 3; i++) await guard.checkPasswordReset(`u${i}@x.test`, "2.2.2.2");
    await expect(guard.checkPasswordReset("nou@x.test", "2.2.2.2")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    for (let i = 0; i < 20; i++) await guard.checkPasswordReset(`g${i}@x.test`, null);
  });

  it("retrimiterea verificării are contoare SEPARATE de resetarea parolei (aceeași adresă, același email)", async () => {
    const { guard } = setup({ passwordResetMaxAttempts: 2, verificationResendMaxAttempts: 2 });
    await guard.checkPasswordReset("a@x.test", "1.1.1.1");
    await guard.checkPasswordReset("a@x.test", "1.1.1.1");
    await expect(guard.checkPasswordReset("a@x.test", "1.1.1.1")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // epuizarea resetării nu consumă nimic din retrimitere
    await guard.checkVerificationResend("a@x.test", "1.1.1.1");
    await guard.checkVerificationResend("a@x.test", "1.1.1.1");
    await expect(guard.checkVerificationResend("a@x.test", "1.1.1.1")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("retrimiterea verificării: limitată pe adresă (20 implicit) și pe email (5 implicit)", async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.checkVerificationResend("a@x.test", `10.0.1.${i + 1}`);
    await expect(guard.checkVerificationResend("a@x.test", "10.0.1.99")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    for (let i = 0; i < 20; i++) await guard.checkVerificationResend(`u${i}@x.test`, "3.3.3.3");
    await expect(guard.checkVerificationResend("nou@x.test", "3.3.3.3")).rejects.toBeInstanceOf(
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
