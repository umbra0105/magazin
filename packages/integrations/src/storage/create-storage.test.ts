import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "@ecom/config";
import { createStorage, resolveStorageDir } from "./create-storage";
import { LocalStorageDriver } from "./local-driver";
import { S3StorageDriver } from "./s3-driver";

const common = {
  NODE_ENV: "test",
  APP_URL: "https://magazin.test/",
  APP_KEY: Buffer.alloc(32, 1).toString("base64"),
  DATABASE_URL: "postgresql://x",
  REDIS_URL: "redis://x",
} as const;

describe("createStorage", () => {
  it("STORAGE_DRIVER=local → LocalStorageDriver", () => {
    const env = { ...common, STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: "/var/ecom" } as Env;
    const driver = createStorage(env);
    expect(driver).toBeInstanceOf(LocalStorageDriver);
    expect(driver.publicUrl("public/a.jpg")).toBe("https://magazin.test/media/a.jpg");
  });

  it("STORAGE_DRIVER=s3 → S3StorageDriver, cu S3_PUBLIC_URL opțional", () => {
    const env = {
      ...common,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "http://s3.example.test:9000",
      S3_REGION: "auto",
      S3_BUCKET: "magazin",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_FORCE_PATH_STYLE: true,
      S3_PUBLIC_URL: "https://cdn.magazin.test",
    } as Env;
    const driver = createStorage(env);
    expect(driver).toBeInstanceOf(S3StorageDriver);
    expect(driver.publicUrl("public/a.jpg")).toBe("https://cdn.magazin.test/public/a.jpg");
  });
});

describe("resolveStorageDir", () => {
  it("o cale absolută rămâne neschimbată", () => {
    const abs = resolve(tmpdir(), "stocare");
    expect(resolveStorageDir(abs, "/oriunde")).toBe(abs);
  });

  it("o cale relativă se ancorează la rădăcina monorepo-ului, din orice subdirector", () => {
    const repo = mkdtempSync(join(tmpdir(), "ecom-repo-"));
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
    const nested = join(repo, "apps", "web");
    mkdirSync(nested, { recursive: true });
    expect(resolveStorageDir("./storage", nested)).toBe(join(repo, "storage"));
    expect(resolveStorageDir("./storage", repo)).toBe(join(repo, "storage"));
  });
});
