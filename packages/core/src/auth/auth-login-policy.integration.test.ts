import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@ecom/db";
import { authSettings } from "../test-utils/auth-settings";
import { createAuth, type AuthSettings } from "./auth";
import { AuthGuard, emailFingerprint } from "./auth-guard";
import { RedisCounterStore } from "./counter-store";
import { PASSWORD_WORK, hashPassword } from "./password";
import { createRedisSecondaryStorage } from "./redis-storage";

/**
 * Politica de autentificare (Blocul C: C-05, C-06), pe Redis și Postgres reale.
 *  - se numără DOAR eșecurile (cinci conectări reușite la rând nu blochează pe nimeni);
 *  - blocare progresivă pe perechea (email, IP) și pe IP; NICIUN străin nu poate bloca contul altcuiva de pe alt IP;
 *  - ritm maxim de încercări pe IP (include reușitele) și 429 imediat când coada argon2 e plină;
 *  - fără IP de încredere (`trustedProxyHops = 0`): prag ×3 și blocare plafonată la un minut.
 */

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const RUN = randomBytes(4).toString("hex");
const emails: string[] = [];
const rand = () => randomBytes(18).toString("base64url");
let ipCounter = 0;
/** IP propriu fiecărui test (TEST-NET-2), ca testele să nu se amestece în contoarele Redis. */
const ip = () => `198.51.100.${(Math.floor(Math.random() * 200) + 1 + ipCounter++) % 250 || 1}`;
const headersOf = (address: string) => new Headers({ "x-forwarded-for": `9.9.9.9, ${address}` });

interface Locks {
  kind: string;
  email: string | null;
  lockoutMinutes: number;
}

function setup(overrides: Partial<AuthSettings> = {}) {
  const settings = authSettings({
    requireEmailVerification: false,
    trustedProxyHops: 1,
    ...overrides,
  });
  const locks: Locks[] = [];
  const store = new RedisCounterStore(redis);
  const guard = new AuthGuard(store, settings);
  const auth = createAuth({
    db,
    guard,
    onLoginLock: (data: Locks) => void locks.push(data),
    secondaryStorage: createRedisSecondaryStorage(redis),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction: false,
    settings,
  } as Parameters<typeof createAuth>[0]);
  return { auth, guard, locks, store };
}

async function newUser(auth: ReturnType<typeof setup>["auth"]) {
  const email = `pol-${RUN}-${emails.length}@test.invalid`;
  emails.push(email);
  const password = rand();
  await auth.api.signUpEmail({
    body: { email, password, name: "Cont Test" },
    headers: headersOf(ip()),
  });
  return { email, password };
}

interface Failure {
  status: number;
  code: string;
  retryAfter: number;
}
async function failureOf(promise: Promise<unknown>): Promise<Failure | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const e = error as {
      statusCode: number;
      body?: { code?: string };
      headers?: Headers | Record<string, string>;
    };
    const headers = e.headers instanceof Headers ? e.headers : new Headers(e.headers);
    return {
      status: e.statusCode,
      code: e.body?.code ?? "",
      retryAfter: Number(headers.get("retry-after") ?? 0),
    };
  }
}
const signIn = (
  auth: ReturnType<typeof setup>["auth"],
  email: string,
  password: string,
  address: string,
) => auth.api.signInEmail({ body: { email, password }, headers: headersOf(address) });

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: emails } } });
  await db.$disconnect();
  redis.disconnect();
});

describe("politica de autentificare (Redis și Postgres reale)", () => {
  it("conectările REUȘITE nu consumă nimic: 12 la rând de pe aceeași adresă trec", async () => {
    const { auth } = setup({ loginMaxAttempts: 3 });
    const u = await newUser(auth);
    const address = ip();
    for (let i = 0; i < 12; i++)
      expect(await failureOf(signIn(auth, u.email, u.password, address))).toBeNull();
  });

  it("după `loginMaxAttempts` eșecuri, perechea (email, IP) primește 429 cu Retry-After, chiar și cu parola corectă", async () => {
    const { auth, locks } = setup({ loginMaxAttempts: 3, lockoutMinutes: 5 });
    const u = await newUser(auth);
    const attacker = ip();
    for (let i = 0; i < 3; i++)
      expect((await failureOf(signIn(auth, u.email, rand(), attacker)))?.status).toBe(401);
    const blocked = await failureOf(signIn(auth, u.email, u.password, attacker));
    expect(blocked?.status).toBe(429);
    expect(blocked?.retryAfter).toBeGreaterThan(0);
    expect(blocked?.retryAfter).toBeLessThanOrEqual(5 * 60);
    expect(locks).toEqual([{ kind: "pair", email: u.email, lockoutMinutes: 5 }]);
  });

  it("UN STRĂIN NU POATE BLOCA CONTUL: proprietarul de pe alt IP se conectează cu parola corectă", async () => {
    const { auth } = setup({ loginMaxAttempts: 3 });
    const owner = await newUser(auth);
    const attacker = ip();
    const ownerAddress = ip();
    for (let i = 0; i < 12; i++) await failureOf(signIn(auth, owner.email, rand(), attacker));
    expect((await failureOf(signIn(auth, owner.email, owner.password, attacker)))?.status).toBe(
      429,
    );
    expect(await failureOf(signIn(auth, owner.email, owner.password, ownerAddress))).toBeNull();
  });

  it("alt email de pe aceeași adresă blocată pe pereche nu e afectat (până la plafonul adresei)", async () => {
    const { auth } = setup({ loginMaxAttempts: 3, loginIpMaxAttempts: 100 });
    const a = await newUser(auth);
    const b = await newUser(auth);
    const address = ip();
    for (let i = 0; i < 3; i++) await failureOf(signIn(auth, a.email, rand(), address));
    expect((await failureOf(signIn(auth, a.email, a.password, address)))?.status).toBe(429);
    expect(await failureOf(signIn(auth, b.email, b.password, address))).toBeNull();
  });

  it("o adresă care greșește pe MAI MULTE emailuri e blocată la `loginIpMaxAttempts` (spray de parole)", async () => {
    const { auth, locks } = setup({
      loginMaxAttempts: 50,
      loginIpMaxAttempts: 5,
      lockoutMinutes: 2,
    });
    const owner = await newUser(auth);
    const attacker = ip();
    for (let i = 0; i < 5; i++) {
      expect(
        (await failureOf(signIn(auth, `nu-exista-${RUN}-${i}@test.invalid`, rand(), attacker)))
          ?.status,
      ).toBe(401);
    }
    const next = await failureOf(signIn(auth, `nu-exista-${RUN}-x@test.invalid`, rand(), attacker));
    expect(next?.status).toBe(429);
    expect(locks.some((l) => l.kind === "ip")).toBe(true);
    // contul real nu e afectat pentru alte adrese
    expect(await failureOf(signIn(auth, owner.email, owner.password, ip()))).toBeNull();
  });

  it("ritmul de încercări pe adresă (reușitele incluse) e limitat: a 6-a în minut primește 429", async () => {
    const { auth } = setup({ loginRatePerMinutePerIp: 5, loginMaxAttempts: 50 });
    const u = await newUser(auth);
    const address = ip();
    for (let i = 0; i < 5; i++)
      expect(await failureOf(signIn(auth, u.email, u.password, address))).toBeNull();
    expect((await failureOf(signIn(auth, u.email, u.password, address)))?.status).toBe(429);
  });

  it("emailurile diferite de pe adrese diferite, împreună, doar declanșează o alertă la `lockoutThreshold`, fără blocare", async () => {
    const { auth, locks } = setup({ loginMaxAttempts: 50, lockoutThreshold: 4 });
    const owner = await newUser(auth);
    for (let i = 0; i < 6; i++) await failureOf(signIn(auth, owner.email, rand(), ip()));
    expect(locks.filter((l) => l.kind === "email_alert")).toEqual([
      { kind: "email_alert", email: owner.email, lockoutMinutes: 0 },
    ]);
    expect(await failureOf(signIn(auth, owner.email, owner.password, ip()))).toBeNull();
  });

  it("un login reușit resetează contorul perechii (eșecurile nu se adună peste reușite)", async () => {
    const { auth } = setup({ loginMaxAttempts: 3 });
    const u = await newUser(auth);
    const address = ip();
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 2; i++) await failureOf(signIn(auth, u.email, rand(), address));
      expect(await failureOf(signIn(auth, u.email, u.password, address))).toBeNull();
    }
  });

  it("fără IP de încredere (hops = 0): prag ×3 și blocare de cel mult un minut", async () => {
    const { auth } = setup({ trustedProxyHops: 0, loginMaxAttempts: 2, lockoutMinutes: 15 });
    const u = await newUser(auth);
    const send = (password: string) => auth.api.signInEmail({ body: { email: u.email, password } });
    for (let i = 0; i < 5; i++) expect((await failureOf(send(rand())))?.status).toBe(401); // sub 2 × 3 = 6
    expect((await failureOf(send(rand())))?.status).toBe(401); // al 6-lea eșec declanșează blocarea
    const blocked = await failureOf(send(u.password));
    expect(blocked?.status).toBe(429);
    expect(blocked?.retryAfter).toBeLessThanOrEqual(60);
  });

  it("blocarea e progresivă: a doua blocare a aceleiași perechi durează dublu", async () => {
    const { auth, store } = setup({ loginMaxAttempts: 2, lockoutMinutes: 1 });
    const u = await newUser(auth);
    const attacker = ip();
    for (let i = 0; i < 2; i++) await failureOf(signIn(auth, u.email, rand(), attacker));
    const first = await failureOf(signIn(auth, u.email, u.password, attacker));
    expect(first?.retryAfter).toBeLessThanOrEqual(60);
    // expiră blocarea (fără să așteptăm): se șterge doar marcajul de blocare, contorul de blocări rămâne
    await store.deleteByPrefix(`lock:pair:${emailFingerprint(u.email)}:`);
    for (let i = 0; i < 2; i++) await failureOf(signIn(auth, u.email, rand(), attacker));
    const second = await failureOf(signIn(auth, u.email, u.password, attacker));
    expect(second?.retryAfter).toBeGreaterThan(60);
    expect(second?.retryAfter).toBeLessThanOrEqual(120);
  });

  it("`unlock(email)` ridică blocările de pe toate adresele", async () => {
    const { auth, guard } = setup({ loginMaxAttempts: 2 });
    const u = await newUser(auth);
    const a = ip();
    const b = ip();
    for (const address of [a, b])
      for (let i = 0; i < 2; i++) await failureOf(signIn(auth, u.email, rand(), address));
    expect((await failureOf(signIn(auth, u.email, u.password, a)))?.status).toBe(429);
    expect((await failureOf(signIn(auth, u.email, u.password, b)))?.status).toBe(429);
    await guard.unlock(u.email);
    expect(await failureOf(signIn(auth, u.email, u.password, a))).toBeNull();
  });

  it("cu coada argon2 plină, autentificarea primește 429 imediat (Retry-After), fără să aștepte", async () => {
    const { auth } = setup();
    const u = await newUser(auth);
    const flood = Array.from({ length: PASSWORD_WORK.queueLimit + 30 }, (_, i) =>
      hashPassword(`umplere-${i}-123456`),
    );
    const started = performance.now();
    const refused = await failureOf(signIn(auth, u.email, u.password, ip()));
    const elapsed = performance.now() - started;
    expect(refused?.status).toBe(429);
    expect(refused?.retryAfter).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
    await Promise.all(flood);
    vi.useRealTimers();
  }, 60_000);
});
