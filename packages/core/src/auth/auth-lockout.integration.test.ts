import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@ecom/db";
import { authSettings } from "../test-utils/auth-settings";
import { createAuth, type AuthSettings } from "./auth";
import { AuthGuard } from "./auth-guard";
import { MemoryCounterStore, RedisCounterStore, ResilientCounterStore } from "./counter-store";
import { createRedisSecondaryStorage } from "./redis-storage";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const RUN = randomBytes(4).toString("hex");
const emails: string[] = [];

const rand = () => randomBytes(18).toString("base64url");

const sentResets: string[] = [];
const fakeEmail = {
  sendVerification: async () => undefined,
  sendPasswordReset: async ({ email }: { email: string }) => {
    sentResets.push(email);
  },
};

function setup(overrides: Partial<AuthSettings> = {}) {
  const settings = authSettings({ requireEmailVerification: false, ...overrides });
  const guard = new AuthGuard(new MemoryCounterStore(), settings);
  const onLoginLock = vi.fn();
  const auth = createAuth({
    db,
    guard,
    onLoginLock,
    email: fakeEmail,
    secondaryStorage: createRedisSecondaryStorage(redis),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction: false,
    settings,
  });
  return { auth, guard, onLoginLock };
}

function newUser() {
  const email = `lock-${RUN}-${emails.length}@test.invalid`;
  emails.push(email);
  return { email, password: rand(), name: "Client Test" };
}

interface Failure {
  status: number;
  code: string;
  message: string;
  retryAfter: string | null;
}

/** Apelează și întoarce eroarea (status, cod, mesaj, Retry-After), sau null dacă a reușit. */
async function failureOf(promise: Promise<unknown>): Promise<Failure | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const e = error as {
      statusCode: number;
      body?: { code?: string; message?: string };
      headers?: Headers | Record<string, string>;
    };
    const headers = e.headers instanceof Headers ? e.headers : new Headers(e.headers);
    return {
      status: e.statusCode,
      code: e.body?.code ?? "",
      message: e.body?.message ?? "",
      retryAfter: headers.get("retry-after"),
    };
  }
}

const signIn = (
  auth: ReturnType<typeof setup>["auth"],
  email: string,
  password: string,
  headers?: Headers,
) => auth.api.signInEmail({ body: { email, password }, headers });

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: emails } } });
  await db.$disconnect();
  redis.disconnect();
});

describe("rate limiting și blocare pe Better Auth", () => {
  it("email inexistent și parolă greșită primesc exact același răspuns (fără enumerare)", async () => {
    const { auth } = setup();
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const wrongPassword = await failureOf(signIn(auth, u.email, rand()));
    const unknownEmail = await failureOf(signIn(auth, `nu-exista-${RUN}@test.invalid`, rand()));
    expect(wrongPassword).not.toBeNull();
    expect(unknownEmail).toEqual(wrongPassword);
    expect(wrongPassword?.status).toBe(401);
  });

  it("timpul de răspuns nu diferă semnificativ între email inexistent și parolă greșită", async () => {
    const { auth } = setup({ loginMaxAttempts: 100, lockoutThreshold: 100 });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const time = async (email: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await failureOf(signIn(auth, email, rand()));
        samples.push(performance.now() - t);
      }
      return samples.sort((a, b) => a - b)[2] ?? 0; // mediana
    };
    await time(u.email); // încălzire (încărcarea modulului nativ)
    const real = await time(u.email);
    const ghost = await time(`nu-exista-${RUN}@test.invalid`);
    // Ambele rulează un hash argon2: raportul rămâne aproape de 1 (toleranță largă contra zgomotului CI).
    expect(Math.max(real, ghost) / Math.min(real, ghost)).toBeLessThan(2.5);
  });

  it("după 5 eșecuri, perechea (email, IP) primește 429 cu Retry-After, cu același corp pentru orice email", async () => {
    const { auth } = setup({ trustedProxyHops: 1 });
    const headers = new Headers({ "x-forwarded-for": "203.0.113.31" });
    const u = newUser();
    await auth.api.signUpEmail({ body: u, headers });
    for (let i = 0; i < 5; i++)
      expect((await failureOf(signIn(auth, u.email, rand(), headers)))?.status).toBe(401);
    const limited = await failureOf(signIn(auth, u.email, u.password, headers)); // chiar și parola corectă
    expect(limited?.status).toBe(429);
    expect(Number(limited?.retryAfter)).toBeGreaterThan(0);

    const ghost = `nu-exista-${RUN}-2@test.invalid`;
    for (let i = 0; i < 5; i++) await failureOf(signIn(auth, ghost, rand(), headers));
    const ghostLimited = await failureOf(signIn(auth, ghost, rand(), headers));
    expect({ ...ghostLimited, retryAfter: null }).toEqual({ ...limited, retryAfter: null });
  });

  it("blocarea se anunță prin onLoginLock și deblocarea (admin:unlock) readuce accesul", async () => {
    const { auth, guard, onLoginLock } = setup({ trustedProxyHops: 1 });
    const headers = new Headers({ "x-forwarded-for": "203.0.113.32" });
    const u = newUser();
    await auth.api.signUpEmail({ body: u, headers });
    for (let i = 0; i < 5; i++) await failureOf(signIn(auth, u.email, rand(), headers));
    expect(onLoginLock).toHaveBeenCalledWith({ kind: "pair", email: u.email, lockoutMinutes: 15 });
    expect((await failureOf(signIn(auth, u.email, u.password, headers)))?.status).toBe(429);
    await guard.unlock(u.email);
    expect(await failureOf(signIn(auth, u.email, u.password, headers))).toBeNull();
  });

  it("un login reușit resetează contorul de eșecuri al perechii", async () => {
    const { auth, onLoginLock } = setup({ trustedProxyHops: 1 });
    const headers = new Headers({ "x-forwarded-for": "203.0.113.33" });
    const u = newUser();
    await auth.api.signUpEmail({ body: u, headers });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await failureOf(signIn(auth, u.email, rand(), headers));
      expect(await failureOf(signIn(auth, u.email, u.password, headers))).toBeNull();
    }
    expect(onLoginLock).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "pair" }));
  });

  it("un cont cu email neverificat și parola corectă nu consumă eșecuri (parola era bună)", async () => {
    const { auth, guard } = setup({ requireEmailVerification: true, loginMaxAttempts: 100 });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    for (let i = 0; i < 12; i++)
      expect((await failureOf(signIn(auth, u.email, u.password)))?.status).toBe(403);
    expect(await guard.lockRemainingSeconds(u.email, null)).toBe(0);
  });

  it("X-Forwarded-For scris de client nu ocolește limita când nu există proxy de încredere", async () => {
    const { auth } = setup({ trustedProxyHops: 0 });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    let limitedAt = 0;
    // fără IP de încredere pragul pe pereche e ×3 (15 eșecuri): clientul care rotește adresa nu scapă de limită
    for (let i = 1; i <= 20; i++) {
      const headers = new Headers({ "x-forwarded-for": `198.51.100.${i}` });
      if ((await failureOf(signIn(auth, u.email, rand(), headers)))?.status === 429) {
        limitedAt = i;
        break;
      }
    }
    expect(limitedAt).toBe(16);
  });

  it("cu un proxy de încredere, IP-ul vine din ultima adresă a lanțului, nu din cea falsificată", async () => {
    const { auth } = setup({ trustedProxyHops: 1 });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    let limitedAt = 0;
    for (let i = 1; i <= 8; i++) {
      // Clientul schimbă prima adresă la fiecare cerere; proxy-ul adaugă la sfârșit IP-ul real.
      const headers = new Headers({ "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` });
      if ((await failureOf(signIn(auth, u.email, rand(), headers)))?.status === 429) {
        limitedAt = i;
        break;
      }
    }
    expect(limitedAt).toBe(6);
  });

  it("înregistrarea e limitată pe IP (5/oră) și răspunde 429", async () => {
    const { auth } = setup({ trustedProxyHops: 1 });
    const headers = new Headers({ "x-forwarded-for": "203.0.113.50" });
    for (let i = 0; i < 5; i++) await auth.api.signUpEmail({ body: newUser(), headers });
    const limited = await failureOf(auth.api.signUpEmail({ body: newUser(), headers }));
    expect(limited?.status).toBe(429);
  });

  it("recuperarea parolei: același răspuns pentru email existent și inexistent; limitată pe email", async () => {
    const { auth } = setup({ passwordResetMaxAttempts: 2 });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const real = await auth.api.requestPasswordReset({ body: { email: u.email } });
    const ghost = await auth.api.requestPasswordReset({
      body: { email: `nu-exista-${RUN}@test.invalid` },
    });
    expect(ghost).toEqual(real);
    await auth.api.requestPasswordReset({ body: { email: u.email } });
    const limited = await failureOf(auth.api.requestPasswordReset({ body: { email: u.email } }));
    expect(limited?.status).toBe(429);
  });

  it("cu Redis căzut, blocarea merge în continuare din memoria procesului", async () => {
    const dead = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on("error", () => undefined);
    const warn = vi.fn();
    const store = new ResilientCounterStore(
      new RedisCounterStore(dead),
      new MemoryCounterStore(),
      { warn },
      100,
    );
    const settings = authSettings({ requireEmailVerification: false, loginMaxAttempts: 2 });
    const guard = new AuthGuard(store, settings);
    const auth = createAuth({
      db,
      guard,
      secondaryStorage: createRedisSecondaryStorage(redis),
      appUrl: "http://localhost:3000",
      secret: randomBytes(32).toString("base64"),
      isProduction: false,
      settings,
    });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    // fără IP de încredere pragul pe pereche e 2 × 3 = 6
    for (let i = 0; i < 6; i++) await failureOf(signIn(auth, u.email, rand()));
    expect((await failureOf(signIn(auth, u.email, u.password)))?.status).toBe(429);
    expect(warn).toHaveBeenCalled();
    dead.disconnect();
  });
});

describe("RedisCounterStore (Redis real)", () => {
  it("fereastră fixă atomică, set/ttl/delete", async () => {
    const store = new RedisCounterStore(redis);
    const key = `test:${RUN}:${rand()}`;
    const first = await store.increment(key, 30);
    expect(first.count).toBe(1);
    expect((await store.increment(key, 30)).count).toBe(2);
    expect((await store.ttl(key)) > 0 && (await store.ttl(key)) <= 30).toBe(true);
    await store.delete(key);
    expect(await store.ttl(key)).toBe(0);
    await store.set(`${key}:lock`, 20);
    expect(await store.ttl(`${key}:lock`)).toBeGreaterThan(0);
    await store.delete(`${key}:lock`);
  });
});
