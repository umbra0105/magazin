import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Env } from "@ecom/config";
import { LocalStorageDriver } from "./local-driver";
import { S3StorageDriver } from "./s3-driver";
import { deriveSigningKey } from "./signing";
import type { StorageDriver } from "./types";

/**
 * Un director relativ din `.env` ar însemna lucruri diferite pentru aplicația web (cwd =
 * apps/web) și pentru worker (cwd = rădăcina). Îl ancorăm la rădăcina monorepo-ului
 * (primul `pnpm-workspace.yaml` urcând din cwd); fără ea, la cwd. În producție: cale absolută.
 */
export function resolveStorageDir(configured: string, cwd: string = process.cwd()): string {
  if (isAbsolute(configured)) return configured;
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return resolve(dir, configured);
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd, configured);
    dir = parent;
  }
}

/** Driverul ales prin `STORAGE_DRIVER` din `.env` (validat de `@ecom/config`). */
export function createStorage(env: Env, cwd?: string): StorageDriver {
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  if (env.STORAGE_DRIVER === "local") {
    return new LocalStorageDriver({
      rootDir: resolveStorageDir(env.STORAGE_LOCAL_PATH, cwd),
      appUrl,
      signingKey: deriveSigningKey(env.APP_KEY),
    });
  }
  return new S3StorageDriver({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    appUrl,
    ...(env.S3_PUBLIC_URL ? { publicBaseUrl: env.S3_PUBLIC_URL } : {}),
  });
}
