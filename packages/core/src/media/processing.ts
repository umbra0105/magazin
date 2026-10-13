import { dirname } from "node:path/posix";
import type { Readable } from "node:stream";
import { isStorageError, type StorageDriver } from "@ecom/integrations";
import type { DecodeLimiter } from "./decode-limiter";
import type { MediaLock } from "./media-lock";
import { MediaError } from "./errors";
import { generateVariants, type GeneratedVariant } from "./variants";
import { z } from "zod";
import { settingGroups } from "../settings/registry";
import type { MediaSettings } from "./upload-handler";

/**
 * Motivul unui eșec de procesare: un COD stabil, nu un mesaj. E singurul lucru care ajunge în
 * `Media.processingError` și în loguri: fără chei de storage, căi, mesaje SDK sau stack trace.
 */
export type ProcessingErrorCode =
  "STORAGE_UNAVAILABLE" | "ORIGINAL_MISSING" | "IMAGE_TOO_LARGE" | "IMAGE_CORRUPT" | "UNEXPECTED";

/** Ce lucru e de făcut când procesarea eșuează: reîncercare (cu backoff) sau eșec definitiv. */
export class MediaProcessingError extends Error {
  constructor(
    readonly code: ProcessingErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "MediaProcessingError";
  }
}

export interface StoredVariant {
  name: string;
  format: string;
  mime: string;
  key: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ProcessingRow {
  id: string;
  status: string;
  storageKey: string;
  variants: StoredVariant[];
}

export interface ProcessingResult {
  variants: StoredVariant[];
  blurhash: string;
  width: number;
  height: number;
}

export interface MediaProcessingStore {
  get(id: string): Promise<ProcessingRow | null>;
  /** `pending`, fără eroare (la cerere de procesare sau regenerare). */
  markPending(id: string): Promise<void>;
  markProcessing(id: string): Promise<void>;
  /** Reîncercare programată: `pending` cu ultimul cod de eroare. */
  markRetrying(id: string, code: ProcessingErrorCode): Promise<void>;
  markReady(id: string, result: ProcessingResult): Promise<void>;
  markFailed(id: string, code: ProcessingErrorCode): Promise<void>;
}

/** Portul către coadă: implementat în `@ecom/jobs` (BullMQ); core nu depinde de coadă. */
export interface MediaJobQueue {
  enqueueProcess(mediaId: string): Promise<void>;
}

export type ProcessOutcome = { status: "ready" } | { status: "busy" } | { status: "skipped" };

export interface ProcessContext {
  /** Ultima încercare permisă: la eșec, status `failed` în loc de reîncercare. */
  finalAttempt: boolean;
}

export interface ProcessorLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface MediaProcessorDeps {
  store: MediaProcessingStore;
  storage: StorageDriver;
  limiter: DecodeLimiter;
  /** Un singur job per fișier la un moment dat (omis = fără lock; doar în teste). */
  lock?: MediaLock;
  getSettings: () => Promise<MediaSettings>;
  logger: ProcessorLogger;
}

/** Plafon de siguranță la citirea originalului din storage (un original curățat e mult sub el). */
const MAX_ORIGINAL_BYTES = 200 * 1024 * 1024;
const IMMUTABLE = "public, max-age=31536000, immutable";

async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new MediaProcessingError("IMAGE_CORRUPT", false);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Procesarea unui fișier din bibliotecă: citește originalul, generează variantele și blurhash,
 * le scrie în storage și actualizează rândul. Rulează în worker (coada `media`), niciodată în
 * cererea de upload.
 *
 * - Ia un loc din limita globală de decodări; dacă nu e loc întoarce `busy` fără să atingă
 *   rândul și fără să numere o încercare: workerul amână jobul.
 * - Limita de pixeli din setări se aplică și aici.
 * - La eșec: reîncercabil (storage) → `pending` + cod; definitiv (imagine coruptă, prea mare,
 *   original lipsă) sau ultima încercare → `failed` + cod. Se aruncă `MediaProcessingError`.
 * - Regenerarea scrie variante noi (cheie cu hash de conținut), apoi scoate din storage pe cele
 *   vechi care nu mai sunt folosite.
 */
export class MediaProcessor {
  constructor(private readonly deps: MediaProcessorDeps) {}

  async process(mediaId: string, context: ProcessContext): Promise<ProcessOutcome> {
    const { store, storage, limiter, logger } = this.deps;

    const row = await store.get(mediaId);
    if (!row) return { status: "skipped" }; // șters între timp

    // Cheile variantelor de acum, copiate înainte de orice scriere: vor fi scoase dacă nu mai sunt folosite.
    const previousKeys = row.variants.map((v) => v.key);

    // Același fișier nu se procesează în paralel (ex. regenerare cerută cât rulează jobul inițial).
    const fileLock = (await this.deps.lock?.tryLock(mediaId)) ?? null;
    if (this.deps.lock && !fileLock) return { status: "busy" };

    let lease;
    try {
      lease = await limiter.tryAcquire();
    } catch (error) {
      await fileLock?.release();
      throw error;
    }
    if (!lease) {
      await fileLock?.release();
      return { status: "busy" };
    }

    try {
      await store.markProcessing(mediaId);
      const settings = await this.deps.getSettings();

      const original = await this.readOriginal(row.storageKey);
      const generated = await generateVariants(original, {
        thumbWidth: settings.thumbWidth,
        mediumWidth: settings.mediumWidth,
        largeWidth: settings.largeWidth,
        avifQuality: settings.avifQuality,
        webpQuality: settings.webpQuality,
        jpegQuality: settings.jpegQuality,
        maxInputPixels: settings.maxInputPixels,
      });
      // Locul din limită se eliberează înainte de scrierile în storage (nu mai decodăm nimic).
      await lease.release();

      const folder = dirname(row.storageKey);
      const stored: StoredVariant[] = [];
      for (const variant of generated.variants) {
        const key = variantKey(folder, variant);
        await storage.put(key, variant.buffer, {
          contentType: variant.mime,
          cacheControl: IMMUTABLE,
        });
        stored.push({
          name: variant.name,
          format: variant.format,
          mime: variant.mime,
          key,
          width: variant.width,
          height: variant.height,
          sizeBytes: variant.buffer.length,
        });
      }

      await store.markReady(mediaId, {
        variants: stored,
        blurhash: generated.blurhash,
        width: generated.width,
        height: generated.height,
      });

      const keep = new Set(stored.map((v) => v.key));
      for (const oldKey of previousKeys) {
        if (!keep.has(oldKey)) await storage.delete(oldKey).catch(() => undefined);
      }
      logger.info({ mediaId, variants: stored.length }, "media: variante generate");
      return { status: "ready" };
    } catch (error) {
      const failure = toProcessingError(error);
      if (failure.retryable && !context.finalAttempt) {
        await store.markRetrying(mediaId, failure.code);
      } else {
        await store.markFailed(mediaId, failure.code);
      }
      logger.warn(
        { mediaId, code: failure.code, retryable: failure.retryable, final: context.finalAttempt },
        "media: procesarea a eșuat",
      );
      throw failure;
    } finally {
      await lease.release();
      await fileLock?.release();
    }
  }

  private async readOriginal(key: string): Promise<Buffer> {
    const { stream } = await this.deps.storage.get(key).catch((error: unknown) => {
      if (isStorageError(error) && error.code === "STORAGE_NOT_FOUND") {
        throw new MediaProcessingError("ORIGINAL_MISSING", false);
      }
      throw error;
    });
    return readAll(stream, MAX_ORIGINAL_BYTES);
  }
}

function variantKey(folder: string, variant: GeneratedVariant): string {
  return `${folder}/${variant.name}.${variant.hash}.${variant.extension}`;
}

export function toProcessingError(error: unknown): MediaProcessingError {
  if (error instanceof MediaProcessingError) return error;
  if (error instanceof MediaError) {
    if (error.code === "MEDIA_IMAGE_TOO_BIG")
      return new MediaProcessingError("IMAGE_TOO_LARGE", false);
    return new MediaProcessingError("IMAGE_CORRUPT", false);
  }
  if (isStorageError(error)) return new MediaProcessingError("STORAGE_UNAVAILABLE", true);
  return new MediaProcessingError("UNEXPECTED", true);
}

/**
 * Cere (re)procesarea unui fișier: îl pune `pending`, fără eroare, și îl trimite în coadă.
 * Folosit la regenerarea variantelor (setări noi, eșec, backfill). Dacă pornirea eșuează,
 * rândul rămâne `pending` și poate fi reluat.
 */
export async function requestMediaProcessing(
  deps: { store: Pick<MediaProcessingStore, "markPending">; queue: MediaJobQueue },
  mediaId: string,
): Promise<void> {
  await deps.store.markPending(mediaId);
  await deps.queue.enqueueProcess(mediaId);
}

/** Valorile implicite ale grupului `media` din registrul de setări (fără baza de date). */
export function defaultMediaSettings(): MediaSettings {
  return z.object(settingGroups.media).parse({});
}
