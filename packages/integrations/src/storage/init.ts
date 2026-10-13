import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { Env } from "@ecom/config";
import { StorageError } from "./types";

export type EnsureBucketResult = "created" | "exists";

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
 * politici, CORS sau obiecte. Accesul public la `public/` se stabilește la servirea fișierelor
 * (Faza 3, punctul 5), împreună cu `S3_PUBLIC_URL`.
 *
 * - `HeadBucket` 404 → se creează;
 * - 403 → bucketul există, dar nu e al nostru sau cheile nu au drepturi: nu încercăm să-l creăm;
 * - `BucketAlreadyOwnedByYou` la creare (cursă între două rulări) → există.
 */
export async function ensureS3Bucket(options: S3ConnectionOptions): Promise<EnsureBucketResult> {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
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
): Promise<{ bucket: string; result: EnsureBucketResult }> {
  if (env.STORAGE_DRIVER !== "s3") {
    throw new StorageError(
      "STORAGE_NOT_CONFIGURED",
      "STORAGE_DRIVER=local: nu există bucket de creat. Inițializarea se aplică doar driverului s3.",
    );
  }
  const result = await ensureS3Bucket({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  return { bucket: env.S3_BUCKET, result };
}
