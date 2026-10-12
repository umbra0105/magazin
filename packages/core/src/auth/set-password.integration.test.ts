import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { ValidationError, type DomainError } from "@ecom/shared";
import { authSettings } from "../test-utils/auth-settings";
import { createAuth } from "./auth";
import { AuthGuard } from "./auth-guard";
import { MemoryCounterStore } from "./counter-store";
import { createRedisSecondaryStorage } from "./redis-storage";
import { revokeCachedSessions, setAccountPassword } from "./set-password";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const storage = createRedisSecondaryStorage(redis);
const RUN = randomBytes(4).toString("hex");
const emails: string[] = [];

const settings = authSettings({ requireEmailVerification: false });
const auth = createAuth({
  db,
  guard: new AuthGuard(new MemoryCounterStore(), settings),
  secondaryStorage: storage,
  appUrl: "http://localhost:3000",
  secret: randomBytes(32).toString("base64"),
  isProduction: false,
  settings,
});

const gen = () => randomBytes(18).toString("base64url");
function newUser() {
  const email = `setpw-${RUN}-${emails.length}@test.invalid`;
  emails.push(email);
  return { email, password: gen(), name: "Cont Test" };
}
const cookieOf = (h: Headers) => (h.get("set-cookie") ?? "").split(";")[0] ?? "";

async function signIn(email: string, password: string) {
  const r = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return new Headers({ cookie: cookieOf(r.headers) });
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

describe("setAccountPassword (admin:set-password)", () => {
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.$disconnect();
    redis.disconnect();
  });

  it("schimbă parola, închide TOATE sesiunile (DB + cache Redis) și auditează fără parolă/hash", async () => {
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const a = await signIn(u.email, u.password);
    const b = await signIn(u.email, u.password);
    expect(await auth.api.getSession({ headers: a })).not.toBeNull();
    expect(await auth.api.getSession({ headers: b })).not.toBeNull();

    const newPassword = gen();
    const result = await db.$transaction((tx) =>
      setAccountPassword(tx, { email: ` ${u.email.toUpperCase()} `, password: newPassword }),
    );
    expect(result.sessionTokens.length).toBe(3); // înregistrarea + 2 autentificări
    expect(await revokeCachedSessions(storage, result.userId, result.sessionTokens)).toBe(true);

    expect(await auth.api.getSession({ headers: a })).toBeNull();
    expect(await auth.api.getSession({ headers: b })).toBeNull();
    expect(await db.session.count({ where: { userId: result.userId } })).toBe(0);

    expect(await errorOf(signIn(u.email, u.password))).not.toBeNull(); // parola veche
    expect(await errorOf(signIn(u.email, newPassword))).toBeNull(); // parola nouă

    const account = await db.account.findFirstOrThrow({
      where: { userId: result.userId, providerId: "credential" },
    });
    expect(account.password).toMatch(/^\$argon2id\$/);

    const [row] = await db.$queryRaw<{ t: string }[]>`
      select row_to_json(a)::text as t from audit_log a
      where "entityId" = ${result.userId} and action = 'auth.password_changed'`;
    expect(row?.t).toContain("schimbare din CLI");
    expect(row?.t).toContain("cli:admin:set-password");
    for (const secret of [u.password, newPassword, account.password ?? ""]) {
      expect(row?.t).not.toContain(secret);
    }
  });

  it("parolă sub 12 caractere: respinsă, nimic nu se schimbă (parola veche merge, sesiunea rămâne)", async () => {
    const u = newUser();
    await auth.api.signUpEmail({ body: u });
    const session = await signIn(u.email, u.password);
    const short = gen().slice(0, 11);
    const error = await errorOf(
      db.$transaction((tx) => setAccountPassword(tx, { email: u.email, password: short })),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(short);
    expect(await auth.api.getSession({ headers: session })).not.toBeNull();
    expect(await errorOf(signIn(u.email, u.password))).toBeNull();
  });

  it("email inexistent: ADMIN_USER_NOT_FOUND", async () => {
    const error = await errorOf(
      db.$transaction((tx) =>
        setAccountPassword(tx, { email: `nu-exista-${RUN}@test.invalid`, password: gen() }),
      ),
    );
    expect((error as DomainError).code).toBe("ADMIN_USER_NOT_FOUND");
  });

  it("cont fără autentificare cu parolă: ADMIN_NO_PASSWORD_ACCOUNT, nimic modificat", async () => {
    const email = `setpw-${RUN}-nopw@test.invalid`;
    emails.push(email);
    await db.user.create({ data: { id: `nopw-${RUN}`, name: "Fără parolă", email } });
    const error = await errorOf(
      db.$transaction((tx) => setAccountPassword(tx, { email, password: gen() })),
    );
    expect((error as DomainError).code).toBe("ADMIN_NO_PASSWORD_ACCOUNT");
    expect(await db.account.count({ where: { userId: `nopw-${RUN}` } })).toBe(0);
  });
});
