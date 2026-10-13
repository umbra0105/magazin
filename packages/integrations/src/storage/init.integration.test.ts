import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { assertTestBucket } from "../../../../test/support/test-env";
import { ensureS3Bucket, initStorage } from "./init";
import { S3StorageDriver } from "./s3-driver";

/**
 * Pe MinIO real. Bucketurile create aici au nume unice care conțin „test”; garda refuză orice alt
 * nume înainte de a crea sau șterge ceva, deci bucketul de dezvoltare (`ecom`) nu poate fi atins.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} lipsește: testele de storage cer MinIO pornit și variabilele S3_*.`);
  }
  return value;
}

const connection = {
  endpoint: requireEnv("S3_ENDPOINT"),
  region: process.env["S3_REGION"] ?? "us-east-1",
  accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
  forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
};

const admin = new S3Client({
  endpoint: connection.endpoint,
  region: connection.region,
  forcePathStyle: connection.forcePathStyle,
  credentials: {
    accessKeyId: connection.accessKeyId,
    secretAccessKey: connection.secretAccessKey,
  },
});

const created: string[] = [];
const newBucket = (): string => {
  const name = `ecom-test-init-${randomBytes(4).toString("hex")}`;
  assertTestBucket(name);
  created.push(name);
  return name;
};

const exists = async (bucket: string): Promise<boolean> => {
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  for (const bucket of created) {
    assertTestBucket(bucket);
    await admin
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: "public/x/keep.txt" }))
      .catch(() => undefined);
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  }
  admin.destroy();
});

describe("ensureS3Bucket pe MinIO (bucket de test)", () => {
  it("creează bucketul lipsă, apoi raportează că există (idempotent)", async () => {
    const bucket = newBucket();
    expect(await exists(bucket)).toBe(false);

    expect(await ensureS3Bucket({ ...connection, bucket })).toBe("created");
    expect(await exists(bucket)).toBe(true);

    expect(await ensureS3Bucket({ ...connection, bucket })).toBe("exists");
    expect(await ensureS3Bucket({ ...connection, bucket })).toBe("exists");
  });

  it("nu atinge conținutul unui bucket existent", async () => {
    const bucket = newBucket();
    await ensureS3Bucket({ ...connection, bucket });
    await admin.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "public/x/keep.txt",
        Body: Buffer.from("păstrează-mă"),
        ContentLength: Buffer.byteLength("păstrează-mă"),
      }),
    );

    expect(await ensureS3Bucket({ ...connection, bucket })).toBe("exists");

    const driver = new S3StorageDriver({ ...connection, bucket, appUrl: "https://magazin.test" });
    expect(await driver.stat("public/x/keep.txt")).toMatchObject({
      size: Buffer.byteLength("păstrează-mă"),
    });
  });

  it("cu chei greșite eșuează cu numele erorii și statusul, fără secrete în mesaj", async () => {
    const bucket = newBucket();
    const error = await ensureS3Bucket({
      ...connection,
      bucket,
      secretAccessKey: "secret-gresit-pentru-test",
    }).catch((e: unknown) => e as Error & { code?: string; details?: unknown });
    expect(error).toMatchObject({ code: "STORAGE_FAILED" });
    const text = JSON.stringify({
      m: (error as Error).message,
      d: (error as { details?: unknown }).details,
    });
    expect(text).not.toContain("secret-gresit-pentru-test");
    expect(text).not.toContain(connection.accessKeyId);
    expect(text).not.toContain(connection.endpoint);
    expect(text).toMatch(/errorName/);
    // nu a creat nimic
    expect(await exists(bucket)).toBe(false);
  });

  it("initStorage refuză driverul local, fără apel de rețea", async () => {
    await expect(
      initStorage({
        NODE_ENV: "test",
        APP_URL: "https://magazin.test",
        APP_KEY: Buffer.alloc(32, 1).toString("base64"),
        DATABASE_URL: "postgresql://x",
        REDIS_URL: "redis://x",
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_PATH: "./storage",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_NOT_CONFIGURED" });
  });
});

describe("pnpm storage:init (comanda reală, ca proces separat)", () => {
  const script = fileURLToPath(new URL("../../../core/scripts/storage-init.ts", import.meta.url));
  const root = fileURLToPath(new URL("../../../..", import.meta.url));

  function run(env: Record<string, string>) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("creează bucketul de test, apoi spune că există; nu afișează endpoint sau chei", () => {
    const bucket = newBucket();
    const env = { STORAGE_DRIVER: "s3", S3_BUCKET: bucket };

    const first = run(env);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Bucketul „${bucket}” a fost creat`);

    const second = run(env);
    expect(second.code).toBe(0);
    expect(second.out).toContain("există deja");

    for (const out of [first.out, second.out]) {
      expect(out).not.toContain(connection.endpoint);
      expect(out).not.toContain(connection.secretAccessKey);
    }
  });

  it("refuză cu STORAGE_DRIVER=local (cod de ieșire 1, mesaj clar)", () => {
    const result = run({ STORAGE_DRIVER: "local" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("STORAGE_DRIVER=local");
  });
});
