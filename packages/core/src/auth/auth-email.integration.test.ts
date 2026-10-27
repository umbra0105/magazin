import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { authSettings } from "../test-utils/auth-settings";
import { deleteByScan, mgetAll, scanKeys } from "../test-utils/redis-scan";
import { createAuth, type AuthEmailSender, type AuthSettings } from "./auth";
import { AuthGuard } from "./auth-guard";
import { MemoryCounterStore } from "./counter-store";
import { DEFAULT_AUTH_PREFIX, createRedisSecondaryStorage } from "./redis-storage";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const RUN = randomBytes(4).toString("hex");
/**
 * Prefix de chei Redis propriu fișierului și rulării: testul vede doar ce a scris el. Indexul Redis de test nu se golește
 * (sesiunile au TTL de zile), deci citirea tuturor cheilor `ecom:auth:*` creștea cu fiecare rulare (41.761 de chei, 14,2 s de
 * `GET`-uri în serie din 15 s). Producția folosește prefixul implicit.
 */
const PREFIX = `${DEFAULT_AUTH_PREFIX}t-${RUN}:`;
const emails: string[] = [];
const gen = () => randomBytes(18).toString("base64url");

function newUser() {
  const email = `mail-${RUN}-${emails.length}@test.invalid`;
  emails.push(email);
  return { email, password: gen(), name: "Cont Test" };
}

function makeAuth(sender: AuthEmailSender, overrides: Partial<AuthSettings> = {}) {
  const settings = authSettings({ requireEmailVerification: true, ...overrides });
  return createAuth({
    db,
    guard: new AuthGuard(new MemoryCounterStore(), settings),
    email: sender,
    secondaryStorage: createRedisSecondaryStorage(redis, PREFIX),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction: false,
    settings,
  });
}

/** Cheile de verificare ale acestei rulări din Redis (cu secondaryStorage, Better Auth ține tokenurile acolo, cu TTL). */
const verificationKeys = () => scanKeys(redis, `${PREFIX}verification:*`);

/** TTL-ul (secunde) al singurei chei de verificare apărute între două momente. */
async function newVerificationTtl(before: string[]): Promise<number> {
  const added = (await verificationKeys()).filter((k) => !before.includes(k));
  expect(added).toHaveLength(1);
  return redis.ttl(added[0] as string);
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { statusCode?: number; body?: { code?: string } };
  }
};

describe("emailurile de autentificare pe Better Auth real", () => {
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await deleteByScan(redis, `${PREFIX}*`);
    await db.$disconnect();
    redis.disconnect();
  });

  it("înregistrarea cere emailul de verificare (o dată) și nu returnează nimic din token", async () => {
    const calls: { userId: string; email: string }[] = [];
    const auth = makeAuth({
      sendVerification: async (d) => void calls.push({ userId: d.userId, email: d.email }),
      sendPasswordReset: async () => undefined,
    });
    const u = newUser();
    const result = await auth.api.signUpEmail({ body: u });
    // Cu verificarea cerută, înregistrarea nu deschide sesiune și nu întoarce niciun token.
    expect(result.token).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.email).toBe(u.email);
  });

  it("un email care nu poate fi trimis NU blochează înregistrarea și nu schimbă răspunsul", async () => {
    const auth = makeAuth({
      sendVerification: async () => {
        throw new Error("coada e picată");
      },
      sendPasswordReset: async () => {
        throw new Error("coada e picată");
      },
    });
    const u = newUser();
    await expect(auth.api.signUpEmail({ body: u })).resolves.toBeDefined();
    expect(await db.user.count({ where: { email: u.email } })).toBe(1);
    // Cererea de resetare nu dă eroare nici când emailul nu poate fi pus în coadă.
    await expect(
      auth.api.requestPasswordReset({ body: { email: u.email } }),
    ).resolves.toBeDefined();
  });

  it("recuperarea parolei: același răspuns pentru cont existent și inexistent; emailul doar pentru cel existent", async () => {
    const resets: { email: string; token: string }[] = [];
    const auth = makeAuth({
      sendVerification: async () => undefined,
      sendPasswordReset: async (d) => void resets.push({ email: d.email, token: d.token }),
    });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });

    const existing = await auth.api.requestPasswordReset({ body: { email: u.email } });
    const ghost = await auth.api.requestPasswordReset({
      body: { email: `nu-exista-${RUN}@test.invalid` },
    });
    expect(ghost).toEqual(existing);
    // Better Auth trimite emailul în fundal; așteptăm scurt.
    await new Promise((r) => setTimeout(r, 200));
    expect(resets.map((r) => r.email)).toEqual([u.email]);
  });

  it("tokenul de resetare: valabil o oră, de unică folosință", async () => {
    let token = "";
    const auth = makeAuth(
      {
        sendVerification: async () => undefined,
        sendPasswordReset: async (d) => {
          token = d.token;
        },
      },
      { passwordResetMinutes: 60 },
    );
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const before = await verificationKeys();
    await auth.api.requestPasswordReset({ body: { email: u.email } });
    await new Promise((r) => setTimeout(r, 200));
    expect(token.length).toBeGreaterThan(16);

    const ttl = await newVerificationTtl(before);
    expect(ttl).toBeGreaterThan(58 * 60);
    expect(ttl).toBeLessThanOrEqual(60 * 60);

    const newPassword = gen();
    await expect(auth.api.resetPassword({ body: { newPassword, token } })).resolves.toBeDefined();
    // A doua folosire a aceluiași token e respinsă.
    const second = await errorOf(auth.api.resetPassword({ body: { newPassword: gen(), token } }));
    expect(second).not.toBeNull();
    expect(second?.body?.code).toBe("INVALID_TOKEN");
  });

  /**
   * Blocul C, C-11: tokenul de resetare a parolei stătea în clar în cheia Redis (`ecom:auth:verification:reset-password:<token>`);
   * cine citea Redis (sau fișierul AOF) putea reseta parola oricui, într-o oră. Acum identificatorul se stochează hash-uit.
   */
  it("tokenul de resetare NU apare în clar în Redis (nici în chei, nici în valori), dar resetarea merge", async () => {
    const resets: { token: string }[] = [];
    const auth = makeAuth({
      sendVerification: async () => undefined,
      sendPasswordReset: async (d) => void resets.push({ token: d.token }),
    });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const before = await verificationKeys();
    await auth.api.requestPasswordReset({ body: { email: u.email } });
    await new Promise((r) => setTimeout(r, 200));
    const token = resets[0]?.token as string;
    expect(token.length).toBeGreaterThan(10);

    // Control pozitiv: tokenul chiar stă în Redis, sub exact o cheie de verificare nouă, a cărei denumire nu îl conține.
    // Fără el, testul ar trece și dacă tokenul n-ar fi ajuns deloc în prefixul citit.
    const added = (await verificationKeys()).filter((k) => !before.includes(k));
    expect(added, "o singură cheie de verificare nouă").toHaveLength(1);
    expect(added[0], "cheia de verificare nouă").not.toContain(token);

    // Toate cheile acestei rulări (în loturi, cu SCAN + MGET): nici numele, nici valoarea nu conțin tokenul.
    const keys = await scanKeys(redis, `${PREFIX}*`);
    expect(keys.length).toBeGreaterThan(0);
    const values = await mgetAll(redis, keys);
    keys.forEach((key, index) => {
      expect(key, "cheie Redis").not.toContain(token);
      expect(values[index] ?? "", `valoarea cheii ${key}`).not.toContain(token);
    });

    const newPassword = gen();
    await auth.api.resetPassword({ body: { token, newPassword } });
    const signedIn = await auth.api
      .signInEmail({ body: { email: u.email, password: newPassword } })
      .catch((e) => e);
    // contul cere verificarea emailului: parola nouă e corectă dacă răspunsul NU e «parolă greșită»
    expect((signedIn as { body?: { code?: string } }).body?.code).not.toBe(
      "INVALID_EMAIL_OR_PASSWORD",
    );
  });

  it("durata tokenului de resetare vine din setarea auth.passwordResetMinutes", async () => {
    let token = "";
    const auth = makeAuth(
      {
        sendVerification: async () => undefined,
        sendPasswordReset: async (d) => {
          token = d.token;
        },
      },
      { passwordResetMinutes: 15 },
    );
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const before = await verificationKeys();
    await auth.api.requestPasswordReset({ body: { email: u.email } });
    await new Promise((r) => setTimeout(r, 200));
    expect(token.length).toBeGreaterThan(16);
    const ttl = await newVerificationTtl(before);
    expect(ttl).toBeGreaterThan(13 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });
});
