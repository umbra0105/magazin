import { randomBytes } from "node:crypto";
import {
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { assertTestBucket } from "../../../../test/support/test-env";
import { ensurePublicReadPolicy, ensureS3Bucket, publicReadPolicy } from "./init";
import { S3StorageDriver } from "./s3-driver";

/**
 * Politica de acces pe MinIO REAL, în bucketuri de test cu nume unic: `public/` se citește
 * anonim, `private/` nu (doar cu link semnat), anonimii nu pot lista, scrie sau șterge, iar o
 * politică străină nu se suprascrie.
 */
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

const admin = new S3Client({
  endpoint: connection.endpoint,
  region: connection.region,
  forcePathStyle: connection.forcePathStyle,
  credentials: {
    accessKeyId: connection.accessKeyId,
    secretAccessKey: connection.secretAccessKey,
  },
});

const buckets: string[] = [];
const newBucket = (): string => {
  const name = `ecom-test-policy-${randomBytes(4).toString("hex")}`;
  assertTestBucket(name);
  buckets.push(name);
  return name;
};

afterAll(async () => {
  for (const bucket of buckets) {
    assertTestBucket(bucket);
    const listed = await admin
      .send(new ListObjectsV2Command({ Bucket: bucket }))
      .catch(() => undefined);
    for (const o of listed?.Contents ?? []) {
      await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
    }
    await admin.send(new DeleteBucketPolicyCommand({ Bucket: bucket })).catch(() => undefined);
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  }
  admin.destroy();
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
const PDF = Buffer.from("%PDF-1.4 secret-privat");

describe("politica de acces pe MinIO real", () => {
  const bucket = newBucket();
  const driver = new S3StorageDriver({
    ...connection,
    bucket,
    appUrl: "https://magazin.test",
    publicBaseUrl: `${connection.endpoint}/${bucket}`,
  });
  const direct = (key: string) => `${connection.endpoint}/${bucket}/${key}`;

  it("pregătește bucketul: politica se aplică, apoi e idempotentă", async () => {
    await ensureS3Bucket({ ...connection, bucket });
    expect(await ensurePublicReadPolicy({ ...connection, bucket })).toBe("applied");
    expect(await ensurePublicReadPolicy({ ...connection, bucket })).toBe("unchanged");
    const stored = await admin.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    expect(JSON.parse(stored.Policy ?? "{}")).toEqual(JSON.parse(publicReadPolicy(bucket)));
    await driver.put("public/media/abc/thumb.1234abcd.jpg", JPEG, {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    });
    await driver.put("private/digital/curs.pdf", PDF, { contentType: "application/pdf" });
  });

  it("public/ se citește ANONIM, cu Content-Type corect și cache imutabil", async () => {
    const res = await fetch(direct("public/media/abc/thumb.1234abcd.jpg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it("adresa din S3_PUBLIC_URL (bucket public) funcționează anonim", async () => {
    const url = driver.publicUrl("public/media/abc/thumb.1234abcd.jpg");
    expect(url).toBe(direct("public/media/abc/thumb.1234abcd.jpg"));
    expect((await fetch(url)).status).toBe(200);
  });

  it("private/ NU se citește anonim (403), nici cu o semnătură greșită", async () => {
    expect((await fetch(direct("private/digital/curs.pdf"))).status).toBe(403);
    const signed = new URL(
      await driver.signedUrl("private/digital/curs.pdf", { expiresInSeconds: 60 }),
    );
    signed.searchParams.set("X-Amz-Signature", "0".repeat(64));
    expect((await fetch(signed)).status).toBe(403);
  });

  it("private/ se citește cu link semnat valid", async () => {
    const url = await driver.signedUrl("private/digital/curs.pdf", {
      expiresInSeconds: 60,
      downloadFilename: "Curs.pdf",
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("anonimii nu pot lista bucketul, scrie sau șterge", async () => {
    expect((await fetch(`${connection.endpoint}/${bucket}/`)).status).toBe(403);
    expect(
      (await fetch(direct("public/media/abc/nou.jpg"), { method: "PUT", body: "x" })).status,
    ).toBe(403);
    expect(
      (await fetch(direct("public/media/abc/thumb.1234abcd.jpg"), { method: "DELETE" })).status,
    ).toBe(403);
    expect((await fetch(direct("public/media/abc/thumb.1234abcd.jpg"))).status).toBe(200);
  });

  it("raport: antetele de securitate trimise de MinIO la citirea directă", async () => {
    const res = await fetch(direct("public/media/abc/thumb.1234abcd.jpg"));
    // Pe obiect nu se pot stoca antete arbitrare (nosniff): se raportează ce trimite MinIO.
    const nosniff = res.headers.get("x-content-type-options");
    console.log(`[raport] MinIO direct: X-Content-Type-Options=${nosniff ?? "(lipsă)"}`);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });
});

describe("politică străină", () => {
  it("o politică existentă care nu e a noastră nu se suprascrie (foreign)", async () => {
    const bucket = newBucket();
    await ensureS3Bucket({ ...connection, bucket });
    const foreign = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AltcinevaAdministreazaAsta",
          Effect: "Allow",
          Principal: { AWS: ["*"] },
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${bucket}/altceva/*`],
        },
      ],
    });
    await admin.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: foreign }));

    expect(await ensurePublicReadPolicy({ ...connection, bucket })).toBe("foreign");
    const stored = await admin.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    expect(JSON.parse(stored.Policy ?? "{}")).toEqual(JSON.parse(foreign));
  });
});
