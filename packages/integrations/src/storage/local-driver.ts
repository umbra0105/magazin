import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { assertValidPrefix, isPublicKey, visibilityOf } from "./keys";
import { signClaims } from "./signing";
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

const META_SUFFIX = ".meta.json";
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;

export interface LocalStorageOptions {
  /** Director rădăcină (absolut). Obiectele stau sub `<root>/<key>`. */
  rootDir: string;
  /** Originea aplicației (APP_URL), fără slash final. */
  appUrl: string;
  /** Cheia de semnare (vezi `deriveSigningKey`). */
  signingKey: Buffer;
  /** Prefix de cale al rutei publice. Implicit `/media`. */
  publicPath?: string;
  /** Prefix de cale al rutei de linkuri semnate. Implicit `/storage/signed`. */
  signedPath?: string;
}

interface Meta {
  contentType: string;
  cacheControl?: string;
  size: number;
}

/** Disc local: pentru dezvoltare și instalări mici fără bucket. Aceleași garanții ca S3. */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = "local" as const;
  private readonly root: string;
  private readonly publicPath: string;
  private readonly signedPath: string;

  constructor(private readonly options: LocalStorageOptions) {
    this.root = resolve(options.rootDir);
    this.publicPath = trimSlashes(options.publicPath ?? "/media");
    this.signedPath = trimSlashes(options.signedPath ?? "/storage/signed");
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Scriere atomică: fișier temporar în același director, apoi rename (nimeni nu citește un
    // fișier pe jumătate scris). Metadatele merg la fel; obiectul „există” când apare fișierul.
    const meta: Meta = {
      contentType: options.contentType,
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
      size: body.length,
    };
    const suffix = `.${randomUUID()}.tmp`;
    try {
      await writeFile(path + META_SUFFIX + suffix, JSON.stringify(meta));
      await rename(path + META_SUFFIX + suffix, path + META_SUFFIX);
      await writeFile(path + suffix, body);
      await rename(path + suffix, path);
    } catch (error) {
      await Promise.allSettled([
        rm(path + suffix, { force: true }),
        rm(path + META_SUFFIX + suffix, { force: true }),
      ]);
      throw new StorageError("STORAGE_FAILED", "Scrierea pe discul local a eșuat", {
        cause: errorMessage(error),
      });
    }
    return { key, size: body.length, contentType: options.contentType };
  }

  async get(key: string): Promise<{ stream: Readable; object: StoredObject }> {
    const object = await this.stat(key);
    if (!object) throw notFound();
    return { stream: createReadStream(this.pathFor(key)), object };
  }

  async stat(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const [info, metaRaw] = await Promise.all([
        fsStat(path),
        readFile(path + META_SUFFIX, "utf8").catch(() => null),
      ]);
      if (!info.isFile()) return null;
      const meta = parseMeta(metaRaw);
      return {
        key,
        size: info.size,
        contentType: meta?.contentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError("STORAGE_FAILED", "Citirea de pe discul local a eșuat", {
        cause: errorMessage(error),
      });
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    try {
      await rm(path, { force: true });
      await rm(path + META_SUFFIX, { force: true });
    } catch (error) {
      throw new StorageError("STORAGE_FAILED", "Ștergerea de pe discul local a eșuat", {
        cause: errorMessage(error),
      });
    }
  }

  publicUrl(key: string): string {
    if (!isPublicKey(key)) {
      throw new StorageError("STORAGE_NOT_PUBLIC", "Obiectul este privat: folosește signedUrl");
    }
    return `${this.options.appUrl}/${this.publicPath}/${encodePath(key.slice("public/".length))}`;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    visibilityOf(key);
    assertExpiry(options.expiresInSeconds);
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
    const claims = {
      key,
      expires,
      ...(options.downloadFilename ? { downloadFilename: options.downloadFilename } : {}),
    };
    const params = new URLSearchParams({
      exp: String(expires),
      sig: signClaims(claims, this.options.signingKey),
    });
    if (options.downloadFilename) params.set("dl", options.downloadFilename);
    return `${this.options.appUrl}/${this.signedPath}/${encodePath(key)}?${params.toString()}`;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    assertValidPrefix(prefix);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const dir = resolve(this.root, ...prefix.split("/").filter(Boolean));
    if (dir !== this.root && !dir.startsWith(this.root + sep)) {
      throw new StorageError("STORAGE_INVALID_KEY", "Prefix de storage invalid: iese din rădăcină");
    }
    const found: ListedObject[] = [];
    const walk = async (current: string, keyPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw new StorageError("STORAGE_FAILED", "Listarea de pe discul local a eșuat", {
          cause: errorMessage(error),
        });
      }
      for (const entry of entries) {
        const key = `${keyPrefix}${entry.name}`;
        if (entry.isDirectory()) {
          await walk(resolve(current, entry.name), `${key}/`);
        } else if (
          entry.isFile() &&
          !entry.name.endsWith(META_SUFFIX) &&
          !entry.name.endsWith(".tmp")
        ) {
          const info = await fsStat(resolve(current, entry.name));
          found.push({ key, size: info.size, lastModified: info.mtime });
        }
      }
    };
    await walk(dir, prefix);
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { objects: found.slice(0, limit), truncated: found.length > limit };
  }

  /** Calea de pe disc pentru o cheie validată; apărare în adâncime peste validarea cheii. */
  private pathFor(key: string): string {
    visibilityOf(key);
    const full = resolve(this.root, ...key.split("/"));
    if (!full.startsWith(this.root + sep)) {
      throw new StorageError("STORAGE_INVALID_KEY", "Cheie de storage invalidă: iese din rădăcină");
    }
    return full;
  }
}

export function assertExpiry(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SIGNED_URL_SECONDS) {
    throw new StorageError(
      "STORAGE_INVALID_EXPIRY",
      `expiresInSeconds trebuie să fie între 1 și ${MAX_SIGNED_URL_SECONDS}`,
    );
  }
}

function parseMeta(raw: string | null): Meta | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "contentType" in value) {
      const contentType = (value as { contentType: unknown }).contentType;
      if (typeof contentType === "string") return value as Meta;
    }
  } catch {
    // metadate corupte: tratate ca lipsă
  }
  return null;
}

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const notFound = (): StorageError => new StorageError("STORAGE_NOT_FOUND", "Obiectul nu există");
