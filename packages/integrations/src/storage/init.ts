import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Env } from "@ecom/config";
import { StorageError } from "./types";

export type EnsureBucketResult = "created" | "exists";
/** `applied`: politica a fost scrisă acum; `unchanged`: era deja; `foreign`: bucketul are o altă politică, neatinsă. */
export type PublicPolicyResult = "applied" | "unchanged" | "foreign";

const POLICY_SID = "EcomPublicRead";

function newClient(options: S3ConnectionOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Politica minimă: citire anonimă DOAR a obiectelor din `public/`. Nicio listare, nicio scriere. */
export function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: POLICY_SID,
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/public/*`],
      },
    ],
  });
}

/**
 * Permite citirea anonimă a prefixului `public/` (și nimic altceva): `private/` rămâne accesibil
 * doar cu URL semnat. Idempotent; o politică existentă care NU e a noastră nu se suprascrie
 * (rezultat `foreign`): o poate administra altcineva (R2, CDN, administrator).
 */
export async function ensurePublicReadPolicy(
  options: S3ConnectionOptions,
): Promise<PublicPolicyResult> {
  const client = newClient(options);
  try {
    let existing: string | undefined;
    try {
      existing = (await client.send(new GetBucketPolicyCommand({ Bucket: options.bucket }))).Policy;
    } catch (error) {
      const e = error as SdkError;
      if (e.name !== "NoSuchBucketPolicy" && e.$metadata?.httpStatusCode !== 404) {
        throw failure("Citirea politicii bucketului a eșuat", error);
      }
    }
    if (existing) {
      let parsed: { Statement?: { Sid?: string }[] } = {};
      try {
        parsed = JSON.parse(existing) as typeof parsed;
      } catch {
        return "foreign";
      }
      const statements = parsed.Statement ?? [];
      const ours = statements.length === 1 && statements[0]?.Sid === POLICY_SID;
      if (!ours) return "foreign";
      if (JSON.stringify(JSON.parse(existing)) === publicReadPolicy(options.bucket)) {
        return "unchanged";
      }
    }
    try {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: options.bucket,
          Policy: publicReadPolicy(options.bucket),
        }),
      );
    } catch (error) {
      throw failure("Aplicarea politicii bucketului a eșuat", error);
    }
    return "applied";
  } finally {
    client.destroy();
  }
}

export interface S3ConnectionOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

interface SdkError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

const failure = (message: string, error: unknown): StorageError => {
  // Doar numele și statusul erorii: mesajul SDK poate conține endpoint-ul sau cheia de acces.
  const e = error as SdkError;
  return new StorageError("STORAGE_FAILED", message, {
    errorName: e?.name,
    status: e?.$metadata?.httpStatusCode,
  });
};

/**
 * Creează bucketul dacă nu există și nu atinge nimic dacă există (idempotent). Nu modifică
 * politici, CORS sau obiecte (politica de citire publică a lui `public/` o aplică
 * `ensurePublicReadPolicy`).
 *
 * - `HeadBucket` 404 → se creează;
 * - 403 → bucketul există, dar nu e al nostru sau cheile nu au drepturi: nu încercăm să-l creăm;
 * - `BucketAlreadyOwnedByYou` la creare (cursă între două rulări) → există.
 */
export async function ensureS3Bucket(options: S3ConnectionOptions): Promise<EnsureBucketResult> {
  const client = newClient(options);
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
      return "exists";
    } catch (error) {
      const e = error as SdkError;
      const missing =
        e.name === "NotFound" || e.name === "NoSuchBucket" || e.$metadata?.httpStatusCode === 404;
      if (!missing) throw failure("Verificarea bucketului a eșuat", error);
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
      return "created";
    } catch (error) {
      if ((error as SdkError).name === "BucketAlreadyOwnedByYou") return "exists";
      throw failure("Crearea bucketului a eșuat", error);
    }
  } finally {
    client.destroy();
  }
}

/**
 * `pnpm storage:init`: pregătește storage-ul configurat în `.env`. Pe driverul local nu există
 * nimic de inițializat (directorul se creează la prima scriere), deci refuză explicit.
 */
export async function initStorage(
  env: Env,
): Promise<{ bucket: string; result: EnsureBucketResult; policy: PublicPolicyResult }> {
  if (env.STORAGE_DRIVER !== "s3") {
    throw new StorageError(
      "STORAGE_NOT_CONFIGURED",
      "STORAGE_DRIVER=local: nu există bucket de creat. Inițializarea se aplică doar driverului s3.",
    );
  }
  const connection: S3ConnectionOptions = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
  const result = await ensureS3Bucket(connection);
  const policy = await ensurePublicReadPolicy(connection);
  return { bucket: env.S3_BUCKET, result, policy };
}
