import type { Readable } from "node:stream";
import { IntegrationError } from "@ecom/shared";

/**
 * Vizibilitatea unui obiect e STRUCTURALĂ: primul segment al cheii e `public` sau `private`
 * (vezi `keys.ts`). Nu există un parametru separat care să poată fi uitat sau greșit.
 */
export type Visibility = "public" | "private";

export interface PutOptions {
  contentType: string;
  /** Ex. `public, max-age=31536000, immutable` pentru fișiere cu nume unic. */
  cacheControl?: string;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface SignedUrlOptions {
  /** 1 secundă … 7 zile. Obligatoriu: nu există link semnat fără expirare. */
  expiresInSeconds: number;
  /** Dacă e setat, răspunsul e o descărcare cu acest nume (Content-Disposition: attachment). */
  downloadFilename?: string;
}

/**
 * Contractul comun pentru discul local și S3-compatible. Folosit de biblioteca media (Faza 3)
 * și, ulterior, de produsele digitale (Faza 14b, fișiere private cu linkuri semnate).
 *
 * `put` primește un buffer: dimensiunea e deja limitată de ruta de upload, iar fișierele mari
 * (video) nu trec pe aici (Bunny Stream). `get` întoarce stream.
 */
export interface StorageDriver {
  readonly kind: "local" | "s3";

  /** Scrie (sau înlocuiește) un obiect. Pe local scrierea e atomică. */
  put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject>;

  /** Stream + metadate. Aruncă `STORAGE_NOT_FOUND` dacă nu există. */
  get(key: string): Promise<{ stream: Readable; object: StoredObject }>;

  /** Metadate sau `null` dacă obiectul nu există. */
  stat(key: string): Promise<StoredObject | null>;

  /** Idempotent: ștergerea unui obiect inexistent nu e eroare. */
  delete(key: string): Promise<void>;

  /**
   * URL stabil, fără semnătură, DOAR pentru chei `public/…` (altfel `STORAGE_NOT_PUBLIC`).
   * Cu `S3_PUBLIC_URL` (CDN / bucket public) arată acolo; altfel trece prin ruta aplicației.
   */
  publicUrl(key: string): string;

  /** Link cu expirare scurtă, valabil pentru orice cheie (publică sau privată). */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string>;
}

export type StorageErrorCode =
  | "STORAGE_INVALID_KEY"
  | "STORAGE_NOT_FOUND"
  | "STORAGE_NOT_PUBLIC"
  | "STORAGE_INVALID_EXPIRY"
  | "STORAGE_FAILED"
  | "STORAGE_NOT_CONFIGURED";

/** Eroare de storage cu cod stabil. Mesajele nu conțin credențiale. */
export class StorageError extends IntegrationError {
  constructor(code: StorageErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}

/**
 * `instanceof` nu e de ajuns între pachete: un bundler poate include modulul în două copii, iar
 * clasa lor ar fi diferită. Codul stabil (`STORAGE_*`) e contractul.
 */
export function isStorageError(error: unknown): error is StorageError {
  if (error instanceof StorageError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && typeof code === "string" && code.startsWith("STORAGE_");
}
