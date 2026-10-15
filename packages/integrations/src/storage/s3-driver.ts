import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import { assertValidPrefix, isPublicKey, visibilityOf } from "./keys";
import { assertExpiry } from "./local-driver";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  StorageError,
  type ListOptions,
  type ListResult,
  type ListedObject,
  type PutOptions,
  type SignedUrlOptions,
  type StorageDriver,
  type StoredObject,
} from "./types";

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Originea aplicației, pentru URL-urile publice care trec prin ruta aplicației. */
  appUrl: string;
  /** CDN sau bucket public (`S3_PUBLIC_URL`); dacă lipsește, `publicUrl` trece prin aplicație. */
  publicBaseUrl?: string;
  /** Prefix de cale al rutei publice a aplicației. Implicit `/media`. */
  publicPath?: string;
}

/** S3-compatibil (MinIO, Cloudflare R2, AWS S3...). Fără cod specific unui furnizor. */
export class S3StorageDriver implements StorageDriver {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly publicPath: string;

  constructor(
    private readonly options: S3StorageOptions,
    clientOverrides: Partial<S3ClientConfig> = {},
  ) {
    this.publicPath = (options.publicPath ?? "/media").replace(/^\/+|\/+$/g, "");
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Sumele de control CRC32 adăugate implicit de SDK-urile noi nu sunt acceptate de toate
      // implementările S3-compatibile: le cerem doar când protocolul le impune.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...clientOverrides,
    });
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    visibilityOf(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentLength: body.length,
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        }),
      );
    } catch (error) {
      throw failed("Scrierea în S3 a eșuat", error);
    }
    return { key, size: body.length, contentType: options.contentType };
  }

  async get(key: string): Promise<{ stream: Readable; object: StoredObject }> {
    visibilityOf(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!out.Body) throw new StorageError("STORAGE_NOT_FOUND", "Obiectul nu există");
      return {
        stream: out.Body as Readable,
        object: {
          key,
          size: out.ContentLength ?? 0,
          contentType: out.ContentType ?? "application/octet-stream",
        },
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (isMissing(error)) throw new StorageError("STORAGE_NOT_FOUND", "Obiectul nu există");
      throw failed("Citirea din S3 a eșuat", error);
    }
  }

  async stat(key: string): Promise<StoredObject | null> {
    visibilityOf(key);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        key,
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw failed("Citirea metadatelor din S3 a eșuat", error);
    }
  }

  async delete(key: string): Promise<void> {
    visibilityOf(key);
    try {
      // S3 răspunde 204 și pentru chei inexistente: ștergerea e idempotentă prin construcție.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      throw failed("Ștergerea din S3 a eșuat", error);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    assertValidPrefix(prefix);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const objects: ListedObject[] = [];
    let token: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: Math.min(limit + 1 - objects.length, 1000),
          }),
        );
        for (const item of out.Contents ?? []) {
          if (!item.Key) continue;
          objects.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified ?? new Date(0),
          });
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token && objects.length <= limit);
    } catch (error) {
      throw failed("Listarea din S3 a eșuat", error);
    }
    return { objects: objects.slice(0, limit), truncated: objects.length > limit };
  }

  publicUrl(key: string): string {
    if (!isPublicKey(key)) {
      throw new StorageError("STORAGE_NOT_PUBLIC", "Obiectul este privat: folosește signedUrl");
    }
    if (this.options.publicBaseUrl) {
      return `${this.options.publicBaseUrl.replace(/\/+$/, "")}/${encodePath(key)}`;
    }
    return `${this.options.appUrl}/${this.publicPath}/${encodePath(key.slice("public/".length))}`;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    visibilityOf(key);
    assertExpiry(options.expiresInSeconds);
    const disposition = options.downloadFilename
      ? contentDisposition(options.downloadFilename)
      : undefined;
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        }),
        { expiresIn: options.expiresInSeconds },
      );
    } catch (error) {
      throw failed("Generarea linkului semnat a eșuat", error);
    }
  }
}

/** `attachment; filename="ascii"; filename*=UTF-8''percent-encoded` (RFC 6266), fără injecție. */
export function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n"\\/]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

function failed(message: string, error: unknown): StorageError {
  // Doar numele și statusul erorii: mesajul SDK poate conține endpoint-ul sau cheia de acces.
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return new StorageError("STORAGE_FAILED", message, {
    errorName: e?.name,
    status: e?.$metadata?.httpStatusCode,
  });
}
