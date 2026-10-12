import { randomUUID } from "node:crypto";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTestBucket } from "../../../../test/support/test-env";
import { S3StorageDriver } from "./s3-driver";

/**
 * Pe MinIO real (docker compose local, serviciu în CI), într-un bucket DE TEST: `vitest.config.mts`
 * îndreaptă S3_BUCKET spre `<bucket>-test` (sau TEST_S3_BUCKET), iar garda de mai jos refuză orice
 * nume fără „test”. Obiectele stau sub un prefix unic per rulare și sunt șterse la final.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} lipsește: testele de storage cer un MinIO pornit (docker compose -f docker/docker-compose.dev.yml up -d) și variabilele S3_* din .env.`,
    );
  }
  return value;
}

const bucket = process.env["S3_BUCKET"];
assertTestBucket(bucket);

const options = {
  endpoint: requireEnv("S3_ENDPOINT"),
  region: process.env["S3_REGION"] ?? "us-east-1",
  bucket,
  accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
  forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
  appUrl: "https://magazin.test",
};

const driver = new S3StorageDriver(options);
const run = `test-run-${randomUUID()}`;
const created: string[] = [];

const keyOf = (visibility: "public" | "private", name: string): string => {
  const key = `${visibility}/${run}/${name}`;
  created.push(key);
  return key;
};

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  const admin = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  try {
    await admin.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  admin.destroy();
});

afterAll(async () => {
  await Promise.all(created.map((key) => driver.delete(key)));
});

describe("S3StorageDriver pe MinIO (bucket de test)", () => {
  it("put → stat → get → delete", async () => {
    const key = keyOf("public", "a.txt");
    const body = Buffer.from("conținut de test");
    expect(await driver.stat(key)).toBeNull();

    const stored = await driver.put(key, body, {
      contentType: "text/plain",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(stored).toEqual({ key, size: body.length, contentType: "text/plain" });
    expect(await driver.stat(key)).toEqual({ key, size: body.length, contentType: "text/plain" });

    const { stream, object } = await driver.get(key);
    expect(object.contentType).toBe("text/plain");
    expect((await read(stream)).equals(body)).toBe(true);

    await driver.delete(key);
    expect(await driver.stat(key)).toBeNull();
    await expect(driver.get(key)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });

  it("ștergerea unui obiect inexistent e idempotentă", async () => {
    await expect(driver.delete(keyOf("public", "nu-exista.bin"))).resolves.toBeUndefined();
  });

  it("obiect privat: URL-ul direct (fără semnătură) e refuzat, linkul semnat funcționează", async () => {
    const key = keyOf("private", "raport.pdf");
    const body = Buffer.from("%PDF-test");
    await driver.put(key, body, { contentType: "application/pdf" });

    const direct = `${options.endpoint}/${bucket}/${key}`;
    expect((await fetch(direct)).status).toBe(403);

    const signed = await driver.signedUrl(key, {
      expiresInSeconds: 60,
      downloadFilename: "Raport vânzări.pdf",
    });
    const response = await fetch(signed);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("Raport");
  });

  it("linkul semnat modificat sau expirat e refuzat", async () => {
    const key = keyOf("private", "scurt.bin");
    await driver.put(key, Buffer.from("x"), { contentType: "application/octet-stream" });

    const signed = new URL(await driver.signedUrl(key, { expiresInSeconds: 1 }));
    const tampered = new URL(signed);
    tampered.pathname = tampered.pathname.replace("scurt.bin", "altceva.bin");
    expect((await fetch(tampered)).status).toBe(403);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await fetch(signed)).status).toBe(403);
  });

  it("publicUrl nu e disponibil pentru obiecte private", () => {
    expect(() => driver.publicUrl("private/x/y.pdf")).toThrowError(
      expect.objectContaining({ code: "STORAGE_NOT_PUBLIC" }),
    );
  });

  it("erorile nu scurg credențialele în mesaj sau detalii", async () => {
    const wrong = new S3StorageDriver({ ...options, secretAccessKey: "alt-secret-gresit" });
    const error = await wrong
      .put(keyOf("public", "refuzat.txt"), Buffer.from("x"), { contentType: "text/plain" })
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "STORAGE_FAILED" });
    const text = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    });
    expect(text).not.toContain("alt-secret-gresit");
    expect(text).not.toContain(options.accessKeyId);
  });
});
