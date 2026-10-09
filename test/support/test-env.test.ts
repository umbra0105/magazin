import { describe, expect, it } from "vitest";
import {
  assertTestDatabase,
  assertTestRedis,
  deriveTestDatabaseUrl,
  deriveTestRedisUrl,
  integrationEnv,
} from "./test-env";

const dev = "postgresql://ecom:parola@localhost:5432/ecom";

describe("deriveTestDatabaseUrl", () => {
  it("adaugă sufixul _test la numele bazei și păstrează restul URL-ului", () => {
    expect(deriveTestDatabaseUrl(dev)).toBe("postgresql://ecom:parola@localhost:5432/ecom_test");
  });

  it("nu dublează sufixul și respectă TEST_DATABASE_URL", () => {
    expect(deriveTestDatabaseUrl("postgresql://u:p@h:5432/ecom_test")).toContain("/ecom_test");
    expect(deriveTestDatabaseUrl("postgresql://u:p@h:5432/ecom_test")).not.toContain("_test_test");
    expect(deriveTestDatabaseUrl(dev, "postgresql://x:y@z:1/altceva_test")).toBe(
      "postgresql://x:y@z:1/altceva_test",
    );
  });
});

describe("deriveTestRedisUrl", () => {
  it("folosește alt index decât dezvoltarea", () => {
    expect(deriveTestRedisUrl("redis://localhost:6379")).toBe("redis://localhost:6379/1");
    expect(deriveTestRedisUrl("redis://localhost:6379/0")).toBe("redis://localhost:6379/1");
    expect(deriveTestRedisUrl("redis://localhost:6379/1")).toBe("redis://localhost:6379/2");
  });
});

describe("gărzile", () => {
  it("refuză o bază fără „test” în nume (inclusiv dacă „test” apare doar în parolă sau host)", () => {
    expect(() => assertTestDatabase(dev)).toThrowError(/REFUZ/);
    expect(() => assertTestDatabase("postgresql://test:test@test.host:5432/ecom")).toThrowError(
      /REFUZ/,
    );
    expect(() => assertTestDatabase(undefined)).toThrowError(/DATABASE_URL/);
  });

  it("acceptă o bază de test", () => {
    expect(() => assertTestDatabase("postgresql://u:p@h:5432/ecom_test")).not.toThrow();
    expect(() => assertTestDatabase("postgresql://u:p@h:5432/test_ecom")).not.toThrow();
  });

  it("refuză Redis DB 0 și acceptă un alt index", () => {
    expect(() => assertTestRedis("redis://localhost:6379")).toThrowError(/REFUZ/);
    expect(() => assertTestRedis("redis://localhost:6379/0")).toThrowError(/REFUZ/);
    expect(() => assertTestRedis("redis://localhost:6379/1")).not.toThrow();
    expect(() => assertTestRedis(undefined)).toThrowError(/REDIS_URL/);
  });
});

describe("integrationEnv", () => {
  it("derivă ambele valori din mediul de dezvoltare", () => {
    expect(
      integrationEnv({
        DATABASE_URL: dev,
        REDIS_URL: "redis://localhost:6379",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      DATABASE_URL: "postgresql://ecom:parola@localhost:5432/ecom_test",
      REDIS_URL: "redis://localhost:6379/1",
    });
  });

  it("nu aruncă și nu inventează nimic când variabilele lipsesc", () => {
    expect(integrationEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it("TEST_* au prioritate", () => {
    const env = integrationEnv({
      DATABASE_URL: dev,
      TEST_DATABASE_URL: "postgresql://a:b@c:5432/proba_test",
      REDIS_URL: "redis://localhost:6379",
      TEST_REDIS_URL: "redis://localhost:6379/5",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      DATABASE_URL: "postgresql://a:b@c:5432/proba_test",
      REDIS_URL: "redis://localhost:6379/5",
    });
  });
});
