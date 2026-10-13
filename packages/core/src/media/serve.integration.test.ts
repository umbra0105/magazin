import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3StorageDriver, ensurePublicReadPolicy, ensureS3Bucket } from "@ecom/integrations";
import { assertTestBucket } from "../../../../test/support/test-env";
import { servePublicObject } from "./serve";

/**
 * `servePublicObject` cu driverul S3 pe MinIO REAL (bucketul de test din `S3_BUCKET`, prefix
 * unic per rulare). Politica de acces (anonim/privat) are testele ei în `@ecom/integrations`.
 */
const bucket = process.env["S3_BUCKET"];
assertTestBucket(bucket);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} lipsește: testele cer MinIO pornit și variabilele S3_*.`);
  return value;
}

const connection = {
  endpoint: requireEnv("S3_ENDPOINT"),
  region: process.env["S3_REGION"] ?? "us-east-1",
  accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
  forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
};

const run = `serve-${randomBytes(4).toString("hex")}`;
const pubKey = `public/${run}/thumb.1234abcd.jpg`;
const privKey = `private/${run}/curs.pdf`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
const PDF = Buffer.from("%PDF-1.4 secret-privat");

const driver = new S3StorageDriver({
  ...connection,
  bucket,
  appUrl: "https://magazin.test",
  publicBaseUrl: `${connection.endpoint}/${bucket}`,
});

beforeAll(async () => {
  await ensureS3Bucket({ ...connection, bucket });
  await ensurePublicReadPolicy({ ...connection, bucket });
  await driver.put(pubKey, JPEG, { contentType: "image/jpeg" });
  await driver.put(privKey, PDF, { contentType: "application/pdf" });
});

afterAll(async () => {
  await Promise.all([driver.delete(pubKey), driver.delete(privKey)]);
});

describe("servirea pe S3 real", () => {
  it("/media: public 200 cu nosniff, Content-Type corect și cache imutabil", async () => {
    const res = await servePublicObject(driver, [run, "thumb.1234abcd.jpg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it("/media: fișierul privat nu se poate cere în nicio formă (404)", async () => {
    const attempts = [
      ["private", run, "curs.pdf"],
      ["..", "private", run, "curs.pdf"],
      [run, "..", "..", "private", run, "curs.pdf"],
      ["%2e%2e", "private", run, "curs.pdf"],
    ];
    for (const segments of attempts) {
      const res = await servePublicObject(driver, segments);
      expect(res.status, segments.join("/")).toBe(404);
      expect(Buffer.from(await res.arrayBuffer()).includes("%PDF")).toBe(false);
    }
  });

  it("URL-ul public din S3_PUBLIC_URL se citește anonim; privatul nu, nici cu cheie ghicită", async () => {
    const pub = driver.publicUrl(pubKey);
    expect(pub).toBe(`${connection.endpoint}/${bucket}/${pubKey}`);
    expect((await fetch(pub)).status).toBe(200);
    expect((await fetch(`${connection.endpoint}/${bucket}/${privKey}`)).status).toBe(403);
    expect(() => driver.publicUrl(privKey)).toThrowError();
  });

  it("linkul semnat pentru privat funcționează, cel modificat nu", async () => {
    const url = new URL(await driver.signedUrl(privKey, { expiresInSeconds: 60 }));
    expect((await fetch(url)).status).toBe(200);
    url.searchParams.set("X-Amz-Signature", "0".repeat(64));
    expect((await fetch(url)).status).toBe(403);
  });
});
