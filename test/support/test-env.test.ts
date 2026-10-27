import { describe, expect, it } from "vitest";
import {
  assertTestBucket,
  assertTestDatabase,
  assertTestRedis,
  deriveE2eRedisUrl,
  deriveTestBucket,
  deriveTestDatabaseUrl,
  deriveTestRedisUrl,
  integrationEnv,
  isTestDatabaseName,
  redisDbIndex,
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

  it("«test» trebuie să fie un segment al numelui, nu un subșir: contest, latest_orders, attestation se refuză", () => {
    for (const name of [
      "contest",
      "latest_orders",
      "attestation",
      "ecom_contests",
      "protest",
      "ecom",
      "ecom_dev",
    ]) {
      expect(() => assertTestDatabase(`postgresql://u:p@h:5432/${name}`), name).toThrowError(
        /REFUZ/,
      );
    }
    for (const name of [
      "test",
      "ecom_test",
      "ecom-test-2",
      "TEST_ecom",
      "ecom_test_ci",
      "ecom_ci_test",
    ]) {
      expect(() => assertTestDatabase(`postgresql://u:p@h:5432/${name}`), name).not.toThrow();
    }
  });

  it("isTestDatabaseName e aceeași regulă, pe nume (o folosesc și curățările care interoghează current_database())", () => {
    expect(isTestDatabaseName("ecom_test")).toBe(true);
    expect(isTestDatabaseName("contest")).toBe(false);
    expect(isTestDatabaseName("")).toBe(false);
  });

  it("derivarea nu consideră «contest» o bază de test: primește sufixul", () => {
    expect(deriveTestDatabaseUrl("postgresql://u:p@h:5432/contest")).toBe(
      "postgresql://u:p@h:5432/contest_test",
    );
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

describe("bucket de test pentru storage", () => {
  it("derivă <bucket>-test și păstrează numele care conțin deja „test”", () => {
    expect(deriveTestBucket("ecom")).toBe("ecom-test");
    expect(deriveTestBucket("ecom-test")).toBe("ecom-test");
    expect(deriveTestBucket("ecom", "alt-bucket-test")).toBe("alt-bucket-test");
  });

  it("refuză un bucket fără „test” în nume și unul lipsă", () => {
    expect(() => assertTestBucket("ecom")).toThrow(/REFUZ/);
    expect(() => assertTestBucket("productie")).toThrow(/test/);
    expect(() => assertTestBucket(undefined)).toThrow();
    expect(() => assertTestBucket("ecom-test")).not.toThrow();
  });

  it("integrationEnv îndreaptă S3_BUCKET spre bucketul de test", () => {
    expect(integrationEnv({ S3_BUCKET: "ecom" } as NodeJS.ProcessEnv)).toEqual({
      S3_BUCKET: "ecom-test",
    });
    expect(
      integrationEnv({ S3_BUCKET: "ecom", TEST_S3_BUCKET: "proba-test" } as NodeJS.ProcessEnv),
    ).toEqual({ S3_BUCKET: "proba-test" });
  });
});

describe("deriveE2eRedisUrl: indexul Redis al suitei E2E, separat de cel al integrării", () => {
  it("indexul 3, cu gazda, portul și parola neschimbate", () => {
    expect(deriveE2eRedisUrl("redis://localhost:6379/1")).toBe("redis://localhost:6379/3");
    expect(deriveE2eRedisUrl("redis://:parola@redis.local:6380/1")).toBe(
      "redis://:parola@redis.local:6380/3",
    );
  });

  it("dacă integrarea e deja pe 3, E2E trece pe 4", () => {
    expect(deriveE2eRedisUrl("redis://localhost:6379/3")).toBe("redis://localhost:6379/4");
  });

  it("niciodată indexul integrării, 0 (dezvoltarea) sau 2 (serverul S3 al E2E), pentru orice index de test", () => {
    for (let index = 1; index <= 14; index++) {
      const url = `redis://localhost:6379/${index}`;
      const e2e = redisDbIndex(deriveE2eRedisUrl(url));
      expect(e2e, `integrare ${index}`).not.toBe(index);
      expect(e2e).not.toBe(0);
      expect(e2e).not.toBe(2);
      expect(e2e).toBeLessThan(16);
    }
  });

  it("trece garda: nu e indexul 0", () => {
    expect(() => assertTestRedis(deriveE2eRedisUrl("redis://localhost:6379/1"))).not.toThrow();
  });
});
