import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const base = {
  APP_URL: "http://localhost:3000",
  APP_KEY: Buffer.alloc(32, 1).toString("base64"),
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

const s3 = {
  STORAGE_DRIVER: "s3",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

describe("parseEnv", () => {
  it("acceptă o configurare S3 validă și aplică valorile implicite", () => {
    const env = parseEnv({ ...base, ...s3 });
    expect(env.NODE_ENV).toBe("development");
    expect(env.STORAGE_DRIVER).toBe("s3");
    if (env.STORAGE_DRIVER === "s3") {
      expect(env.S3_REGION).toBe("auto");
      expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    }
  });

  it("convertește S3_FORCE_PATH_STYLE din șir în boolean", () => {
    const env = parseEnv({ ...base, ...s3, S3_FORCE_PATH_STYLE: "true" });
    if (env.STORAGE_DRIVER === "s3") expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("S3_PUBLIC_URL e opțional și trebuie să fie un URL complet", () => {
    const withoutUrl = parseEnv({ ...base, ...s3 });
    if (withoutUrl.STORAGE_DRIVER === "s3") expect(withoutUrl.S3_PUBLIC_URL).toBeUndefined();
    const withUrl = parseEnv({ ...base, ...s3, S3_PUBLIC_URL: "https://cdn.magazin.ro" });
    if (withUrl.STORAGE_DRIVER === "s3") {
      expect(withUrl.S3_PUBLIC_URL).toBe("https://cdn.magazin.ro");
    }
    expect(() => parseEnv({ ...base, ...s3, S3_PUBLIC_URL: "cdn.magazin.ro" })).toThrow(
      EnvValidationError,
    );
  });

  it("acceptă driverul local fără variabile S3", () => {
    const env = parseEnv({ ...base, STORAGE_DRIVER: "local" });
    if (env.STORAGE_DRIVER === "local") expect(env.STORAGE_LOCAL_PATH).toBe("./storage");
  });

  it("cere variabilele S3 doar când driverul este s3", () => {
    expect(() => parseEnv({ ...base, STORAGE_DRIVER: "s3" })).toThrow(EnvValidationError);
  });

  it("listează toate variabilele lipsă, în română", () => {
    try {
      parseEnv({ STORAGE_DRIVER: "local" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues).toContain("APP_URL: lipsește");
      expect(issues).toContain("DATABASE_URL: lipsește");
      expect(issues).toContain("REDIS_URL: lipsește");
    }
  });

  it("respinge un APP_KEY care nu are 32 de octeți", () => {
    expect(() =>
      parseEnv({ ...base, APP_KEY: Buffer.alloc(16).toString("base64"), STORAGE_DRIVER: "local" }),
    ).toThrow(/APP_KEY/);
  });

  it("tratează șirurile goale ca absente (SENTRY_DSN opțional)", () => {
    const env = parseEnv({ ...base, STORAGE_DRIVER: "local", SENTRY_DSN: "" });
    expect(env.SENTRY_DSN).toBeUndefined();
  });
});
