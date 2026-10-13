import { createHash } from "node:crypto";
import { MediaError } from "./errors";

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export const MIME_EXTENSION: Record<ImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** Formatul raportat de sharp pentru fiecare tip (AVIF vine ca `heif`). */
const SHARP_FORMAT: Record<ImageMime, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "heif",
};

export interface ImageLimits {
  allowedMimeTypes: readonly string[];
  maxInputPixels: number;
}

export interface SanitizedImage {
  /** Original curățat: aceeași formă, orientare aplicată, fără EXIF/GPS/XMP/IPTC. */
  buffer: Buffer;
  mime: ImageMime;
  extension: string;
  width: number;
  height: number;
  /** SHA-256 (hex) al `buffer`-ului curățat. */
  checksum: string;
}

const isImageMime = (value: string): value is ImageMime =>
  (IMAGE_MIME_TYPES as readonly string[]).includes(value);

/**
 * Validează și curăță o imagine încărcată. Tipul vine DOAR din conținut (octeții de la început),
 * niciodată din `Content-Type`-ul declarat sau din extensia numelui. Imaginea e decodată și
 * re-codificată, ceea ce:
 *  - scoate metadatele (EXIF cu GPS, XMP, IPTC, comentarii) înainte ca fișierul să ajungă pe disc;
 *  - neutralizează conținutul „poliglot” (o imagine care e și HTML/script);
 *  - aplică orientarea EXIF (poza rămâne în picioare, iar eticheta dispare).
 * Pixelii se verifică din antet ÎNAINTE de decodare (împotriva imaginilor-bombă).
 * Imaginile animate: se păstrează doar primul cadru.
 *
 * Re-codificarea e aproape fără pierderi (JPEG 4:4:4 calitate 95, PNG fără pierderi), nu
 * identică bit cu bit: originalul curățat servește la regenerarea variantelor.
 */
export async function sanitizeImage(bytes: Buffer, limits: ImageLimits): Promise<SanitizedImage> {
  if (bytes.length === 0) throw new MediaError("MEDIA_EMPTY", "Fișierul e gol");

  // Import leneș: `sharp` e un modul nativ. @ecom/core se încarcă în toată aplicația și în worker;
  // dacă modulul nu se poate încărca pe o mașină, doar încărcarea de imagini cade, nu tot restul.
  const [{ fileTypeFromBuffer }, { default: sharp }] = await Promise.all([
    import("file-type"),
    import("sharp"),
  ]);

  const detected = await fileTypeFromBuffer(bytes);
  if (
    !detected ||
    !isImageMime(detected.mime) ||
    !limits.allowedMimeTypes.includes(detected.mime)
  ) {
    throw new MediaError("MEDIA_UNSUPPORTED_TYPE", "Tipul de fișier nu este acceptat");
  }
  const mime = detected.mime;

  try {
    const input = sharp(bytes, { limitInputPixels: limits.maxInputPixels, failOn: "error" });
    const meta = await input.metadata();
    if (meta.format !== SHARP_FORMAT[mime]) {
      throw new MediaError("MEDIA_CORRUPT", "Conținutul fișierului nu corespunde tipului detectat");
    }
    const { width, height } = meta;
    if (!width || !height) throw new MediaError("MEDIA_CORRUPT", "Imaginea nu are dimensiuni");
    if (width * height > limits.maxInputPixels) {
      throw new MediaError("MEDIA_IMAGE_TOO_BIG", "Imaginea are prea mulți pixeli", {
        maxInputPixels: limits.maxInputPixels,
      });
    }

    // `rotate()` aplică orientarea EXIF; sharp nu copiază metadatele în ieșire decât la cerere.
    const pipeline = input.rotate();
    const encoded =
      mime === "image/jpeg"
        ? pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        : mime === "image/png"
          ? pipeline.png({ compressionLevel: 9 })
          : mime === "image/webp"
            ? pipeline.webp({ quality: 95 })
            : pipeline.avif({ quality: 90, effort: 2 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      mime,
      extension: MIME_EXTENSION[mime],
      width: info.width,
      height: info.height,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    // sharp aruncă și la depășirea `limitInputPixels`; mesajul lui conține detalii interne.
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new MediaError("MEDIA_IMAGE_TOO_BIG", "Imaginea are prea mulți pixeli", {
        maxInputPixels: limits.maxInputPixels,
      });
    }
    throw new MediaError("MEDIA_CORRUPT", "Imaginea nu poate fi citită (fișier corupt)");
  }
}
