import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { authSettings } from "../test-utils/auth-settings";
import { createAuth, type AuthSettings } from "./auth";
import { AuthGuard } from "./auth-guard";
import { MemoryCounterStore } from "./counter-store";
import { createRedisSecondaryStorage } from "./redis-storage";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const RUN = randomBytes(4).toString("hex");
const emails: string[] = [];

function makeAuth(overrides: Partial<AuthSettings> = {}) {
  const settings = authSettings({ requireEmailVerification: false, ...overrides });
  return createAuth({
    guard: new AuthGuard(new MemoryCounterStore(), settings),
    db,
    secondaryStorage: createRedisSecondaryStorage(redis),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction: false,
    settings,
  });
}

/** Email unic pe rulare; parolele sunt generate în memorie, nu apar în cod. */
function newUser() {
  const email = `auth-${RUN}-${emails.length}@test.invalid`;
  emails.push(email);
  return { email, password: randomBytes(18).toString("base64url"), name: "Client Test" };
}

const origin = { headers: new Headers({ origin: "http://localhost:3000" }) };

describe("Better Auth pe baza de test", () => {
  beforeAll(async () => {
    await redis.ping();
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.$disconnect();
    redis.disconnect();
  });

  it("înregistrează un client și îi stochează parola ca hash argon2id", async () => {
    const auth = makeAuth();
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const account = await db.account.findFirstOrThrow({
      where: { user: { email: u.email }, providerId: "credential" },
    });
    expect(account.password).toMatch(/^\$argon2id\$/);
    expect(account.password).not.toContain(u.password);
  });

  it("respinge o parolă sub 12 caractere", async () => {
    const auth = makeAuth();
    const u = { ...newUser(), password: "scurta-11ch" };
    expect(u.password).toHaveLength(11);
    await expect(auth.api.signUpEmail({ body: u })).rejects.toThrow();
    expect(await db.user.count({ where: { email: u.email } })).toBe(0);
  });

  it("nu impune reguli de compoziție: 12 litere mici sunt acceptate", async () => {
    const auth = makeAuth();
    const u = { ...newUser(), password: "abcdefghijkl" };
    await expect(auth.api.signUpEmail({ body: u })).resolves.toBeDefined();
  });

  it("ignoră rolul, permisiunile și alte câmpuri privilegiate trimise la înregistrare", async () => {
    const auth = makeAuth();
    const u = newUser();
    const hostile = {
      ...u,
      role: "owner",
      roles: ["owner"],
      permissions: ["*"],
      emailVerified: true,
      isAdmin: true,
      id: "forced-id",
    };
    await auth.api.signUpEmail({ body: hostile as typeof u });
    const row = await db.user.findUniqueOrThrow({
      where: { email: u.email },
      include: { roles: true },
    });
    expect(row.roles).toHaveLength(0);
    expect(row.emailVerified).toBe(false);
    expect(row.id).not.toBe("forced-id");
  });

  it("login corect creează sesiune; parolă greșită nu", async () => {
    const auth = makeAuth();
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const ok = await auth.api.signInEmail({ body: { email: u.email, password: u.password } });
    expect(ok.token).toBeTruthy();
    await expect(
      auth.api.signInEmail({ body: { email: u.email, password: randomBytes(18).toString("hex") } }),
    ).rejects.toThrow();
  });

  it("cu verificarea cerută, login-ul e refuzat până la verificarea emailului", async () => {
    const auth = makeAuth({ requireEmailVerification: true });
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    await expect(
      auth.api.signInEmail({ body: { email: u.email, password: u.password } }),
    ).rejects.toThrow();
  });

  it("cookie-ul de sesiune e httpOnly și sameSite=lax", async () => {
    const auth = makeAuth();
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      }),
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // doar în producție
  });

  it("schimbarea parolei închide celelalte sesiuni chiar dacă clientul nu o cere", async () => {
    const auth = makeAuth();
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const a = await auth.api.signInEmail({
      body: { email: u.email, password: u.password },
      returnHeaders: true,
    });
    const b = await auth.api.signInEmail({
      body: { email: u.email, password: u.password },
      returnHeaders: true,
    });
    const cookieOf = (h: Headers) => (h.get("set-cookie") ?? "").split(";")[0] ?? "";
    const headersA = new Headers({
      cookie: cookieOf(a.headers),
      ...Object.fromEntries(origin.headers),
    });
    const headersB = new Headers({
      cookie: cookieOf(b.headers),
      ...Object.fromEntries(origin.headers),
    });

    const newPassword = randomBytes(18).toString("base64url");
    const changed = await auth.api.changePassword({
      headers: headersA,
      body: { currentPassword: u.password, newPassword },
      returnHeaders: true,
    });

    // Sesiunea B (alt dispozitiv) e închisă; cea curentă primește un token nou.
    expect(await auth.api.getSession({ headers: headersB })).toBeNull();
    const rotated = new Headers({ cookie: cookieOf(changed.headers) });
    expect(await auth.api.getSession({ headers: rotated })).not.toBeNull();
  });
});
