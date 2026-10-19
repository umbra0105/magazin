import { randomUUID } from "node:crypto";
import type { StorageDriver } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import type { DecodeLimiter } from "./decode-limiter";
import { MediaError } from "./errors";
import { sanitizeImage, type ImageLimits } from "./image";
import type { MediaRow, MediaStore } from "./media-store";

export interface UploadCommand {
  bytes: Buffer;
  /** Numele afișat (deja curățat cu `sanitizeFileName`). */
  originalName: string;
  folderId?: string | null;
  alt?: string;
  uploadedById: string | null;
  limits: ImageLimits;
  /** Doar la imaginile aduse prin import din adresă: hash-ul adresei sursă normalizate. */
  sourceHash?: string | null;
}

export interface UploadedMedia extends MediaRow {
  url: string;
}

export interface MediaServiceDeps {
  store: MediaStore;
  storage: StorageDriver;
  /**
   * Limita globală de decodări de imagini (aceeași ca în worker). Fără loc liber, încărcarea e
   * refuzată cu `MEDIA_BUSY` (503 + Retry-After) înainte de orice decodare. Omis = fără limită.
   */
  limiter?: DecodeLimiter;
  /** Doar în teste: înlocuiește `sanitizeImage`. */
  sanitize?: typeof sanitizeImage;
  /**
   * Apelat după ce fișierul și rândul există (aici pornește procesarea în queue, punctul 4).
   * O eroare aici nu anulează încărcarea: fișierul rămâne `pending` și poate fi reluat.
   */
  onCreated?: (media: MediaRow) => Promise<void>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export class MediaService {
  constructor(private readonly deps: MediaServiceDeps) {}

  /**
   * Validează, curăță și stochează o imagine, apoi creează rândul `Media` (status `pending`).
   * Cheia e `public/media/<uuid>/original.<ext>`: fără numele fișierului, fără date personale.
   * Ordinea: storage întâi, apoi baza de date; dacă baza de date eșuează, obiectul se șterge.
   */
  async upload(command: UploadCommand): Promise<UploadedMedia> {
    const { store, storage } = this.deps;

    if (command.folderId && !(await store.folderExists(command.folderId))) {
      throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "Folderul nu există");
    }

    const lease = (await this.deps.limiter?.tryAcquire()) ?? null;
    if (this.deps.limiter && !lease) {
      throw new MediaError("MEDIA_BUSY", "Se procesează prea multe imagini în acest moment");
    }
    let image;
    try {
      image = await (this.deps.sanitize ?? sanitizeImage)(command.bytes, command.limits);
    } finally {
      await lease?.release();
    }
    const key = `public/media/${randomUUID()}/original.${image.extension}`;

    await storage.put(key, image.buffer, { contentType: image.mime, cacheControl: IMMUTABLE });

    let row: MediaRow;
    try {
      row = await store.create({
        mime: image.mime,
        sizeBytes: image.buffer.length,
        width: image.width,
        height: image.height,
        checksum: image.checksum,
        originalName: command.originalName,
        storageKey: key,
        alt: (command.alt ?? "").slice(0, 300),
        folderId: command.folderId ?? null,
        uploadedById: command.uploadedById,
        ...(command.sourceHash && { sourceHash: command.sourceHash }),
      });
    } catch (error) {
      await storage.delete(key).catch(() => undefined);
      throw error;
    }

    if (this.deps.onCreated) {
      try {
        await this.deps.onCreated(row);
      } catch (error) {
        getLogger().error({ err: error, mediaId: row.id }, "pornirea procesării media a eșuat");
      }
    }
    return { ...row, url: storage.publicUrl(key) };
  }
}
