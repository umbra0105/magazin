import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { authSettings } from "../test-utils/auth-settings";
import { createAuth, type AuthSettings } from "./auth";
import { AuthGuard } from "./auth-guard";
import { RedisCounterStore } from "./counter-store";
import { createRedisSecondaryStorage } from "./redis-storage";

/**
 * Blocul C, C-07, pe Redis real: hook-ul de autentificare construia chei Redis din emailul BRUT (neverificat, până la
 * megabytes) și hash-uia parola trimisă de client oricât de lungă. Acum emailul se validează (lungime, formă) înainte
 * de orice contor, cheile conțin doar o amprentă de lungime fixă, iar o parolă absurdă e respinsă fără să fie hash-uită.
 */

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const RUN = randomBytes(4).toString("hex");
const emails: string[] = [];
afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: emails } } });
  await db.$disconnect();
  redis.disconnect();
});

function setup(overrides: Partial<AuthSettings> = {}) {
  const settings = authSettings({ requireEmailVerification: false, ...overrides });
  return createAuth({
    db,
    guard: new AuthGuard(new RedisCounterStore(redis), settings),
    secondaryStorage: createRedisSecondaryStorage(redis),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction: false,
    settings,
  });
}

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
};

const rateKeys = () => redis.keys("ecom:rl:*");

/** Cheile apărute în timpul unui pas (alte fișiere de test rulează în paralel; chei rămase dintr-o rulare veche nu contează). */
async function newRateKeys(step: () => Promise<void>): Promise<string[]> {
  const before = new Set(await rateKeys());
  await step();
  return (await rateKeys()).filter((key) => !before.has(key));
}

describe("hook-ul de autentificare nu ia încredere în intrare (Redis real)", () => {
  it("un email de 5 MB se respinge (400) fără să creeze chei în Redis", async () => {
    const auth = setup({ trustedProxyHops: 1 });
    const huge = `${"a".repeat(5_000_000)}-${RUN}@test.invalid`;
    const headers = new Headers({ "x-forwarded-for": "203.0.113.20" });
    const added = await newRateKeys(async () => {
      for (const call of [
        () => auth.api.signInEmail({ body: { email: huge, password: "x".repeat(20) }, headers }),
        () =>
          auth.api.signUpEmail({
            body: { email: huge, password: "x".repeat(20), name: "A" },
            headers,
          }),
        () => auth.api.requestPasswordReset({ body: { email: huge }, headers }),
      ]) {
        expect(await statusOf(call())).toBe(400);
      }
    });
    expect(added).toEqual([]);
  });

  it("cheile de limitare nu conțin emailul în clar, doar o amprentă de lungime fixă", async () => {
    const auth = setup({ trustedProxyHops: 1 });
    const email = `amprenta-${RUN}@test.invalid`;
    const headers = new Headers({ "x-forwarded-for": "203.0.113.21" });
    const added = await newRateKeys(async () => {
      expect(
        await statusOf(
          auth.api.signInEmail({ body: { email, password: "x".repeat(20) }, headers }),
        ),
      ).toBe(401);
    });
    expect(added.length).toBeGreaterThan(0);
    for (const key of added) {
      expect(key).not.toContain(RUN);
      expect(key).not.toContain("amprenta");
      expect(key.length).toBeLessThan(120);
    }
  });

  it("o parolă de 200.000 de caractere la autentificare se respinge repede (400 sau 401), fără muncă de hash", async () => {
    const auth = setup();
    const email = `parola-${RUN}@test.invalid`;
    emails.push(email);
    await auth.api.signUpEmail({ body: { email, password: "valid-password-123456", name: "A" } });
    const started = performance.now();
    const status = await statusOf(
      auth.api.signInEmail({ body: { email, password: "p".repeat(200_000) } }),
    );
    expect([400, 401]).toContain(status);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("corpuri fără email sau cu tipuri greșite nu aruncă din hook", async () => {
    const auth = setup();
    for (const body of [{}, { email: 5 }, { email: null }, { email: ["a@b.c"] }]) {
      const status = await statusOf(
        (auth.api.signInEmail as (input: unknown) => Promise<unknown>)({
          body: { ...body, password: "x".repeat(20) },
        }),
      );
      expect([400, 401, 422]).toContain(status);
    }
  });
});
