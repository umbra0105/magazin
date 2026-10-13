import { createRequire } from "node:module";
import { join } from "node:path";
import { assertTestBucket, deriveTestBucket } from "../../test/support/test-env";

/**
 * Ajutoare pentru testul E2E pe driverul S3 (MinIO). Clientul AWS se rezolvă din pachetul
 * `@ecom/integrations` (singurul care îl declară), fără să-l adauge în rădăcină.
 */
const integrationsRequire = createRequire(
  join(process.cwd(), "packages", "integrations", "package.json"),
);

interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
  destroy(): void;
}

interface S3Module {
  S3Client: new (config: unknown) => S3ClientLike;
  PutObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
}

export interface S3E2eEnv {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Baza adreselor publice (fără slash final): endpoint + bucket. */
  publicUrl: string;
}

/**
 * Configurația S3 a testului. Bucketul e MEREU cel de test (`TEST_S3_BUCKET` sau `<S3_BUCKET>-test`)
 * și trece prin garda „test” în nume; nu poate ajunge pe bucketul de dezvoltare.
 */
export function s3E2eEnv(env: NodeJS.ProcessEnv = process.env): S3E2eEnv {
  const endpoint = env["S3_ENDPOINT"];
  const accessKeyId = env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"];
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Testul E2E pe S3 cere S3_ENDPOINT, S3_ACCESS_KEY_ID și S3_SECRET_ACCESS_KEY (din .env sau CI) " +
        "și un MinIO pornit (docker compose -f docker/docker-compose.dev.yml up -d).",
    );
  }
  const bucket = deriveTestBucket(env["S3_BUCKET"] ?? "ecom", env["TEST_S3_BUCKET"]);
  assertTestBucket(bucket);
  const base = endpoint.replace(/\/+$/, "");
  return {
    endpoint: base,
    region: env["S3_REGION"] ?? "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: (env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
    publicUrl: `${base}/${bucket}`,
  };
}

function client(config: S3E2eEnv): S3ClientLike {
  const { S3Client } = integrationsRequire("@aws-sdk/client-s3") as S3Module;
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/** Scrie un obiect (ex. sub `private/`), direct în bucketul de test. */
export async function putTestObject(
  config: S3E2eEnv,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { PutObjectCommand } = integrationsRequire("@aws-sdk/client-s3") as S3Module;
  const s3 = client(config);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  } finally {
    s3.destroy();
  }
}

export async function deleteTestObject(config: S3E2eEnv, key: string): Promise<void> {
  const { DeleteObjectCommand } = integrationsRequire("@aws-sdk/client-s3") as S3Module;
  const s3 = client(config);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } finally {
    s3.destroy();
  }
}

/** Link semnat (presigned) de citire, valabil 60 s. */
export async function presignGet(config: S3E2eEnv, key: string): Promise<string> {
  const { GetObjectCommand } = integrationsRequire("@aws-sdk/client-s3") as S3Module;
  const presigner = integrationsRequire("@aws-sdk/s3-request-presigner") as {
    getSignedUrl(
      client: unknown,
      command: unknown,
      options: { expiresIn: number },
    ): Promise<string>;
  };
  const s3 = client(config);
  try {
    return await presigner.getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      { expiresIn: 60 },
    );
  } finally {
    s3.destroy();
  }
}
