import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { getSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import {
  AuthGuard,
  MemoryCounterStore,
  createAuth,
  createRedisSecondaryStorage,
  settingGroups,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { SECURE_COOKIE_PREFIX, SESSION_COOKIE_NAME, hasSessionCookie } from "./session-cookie";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
  lazyConnect: true,
});

async function realCookieName(isProduction: boolean): Promise<string> {
  const settings = z.object(settingGroups.auth).parse({});
  const auth = createAuth({
    guard: new AuthGuard(new MemoryCounterStore(), settings),
    db,
    secondaryStorage: createRedisSecondaryStorage(redis),
    appUrl: "http://localhost:3000",
    secret: randomBytes(32).toString("base64"),
    isProduction,
    settings,
  });
  return (await auth.$context).authCookies.sessionToken.name;
}

describe("numele cookie-ului de sesiune din middleware = cel real din Better Auth", () => {
  afterAll(async () => {
    await db.$disconnect();
    redis.disconnect();
  });

  it("dezvoltare: fără prefix __Secure-", async () => {
    const name = await realCookieName(false);
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(hasSessionCookie(`${name}=token`)).toBe(true);
    expect(getSessionCookie(new Headers({ cookie: `${name}=token` }))).toBe("token");
  });

  it("producție (useSecureCookies): cu prefix __Secure-", async () => {
    const name = await realCookieName(true);
    expect(name).toBe(`${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`);
    expect(hasSessionCookie(`${name}=token`)).toBe(true);
    expect(getSessionCookie(new Headers({ cookie: `${name}=token` }))).toBe("token");
  });
});
