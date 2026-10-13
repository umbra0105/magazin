import { createHash } from "node:crypto";
import { MediaError } from "./errors";

export const VARIANT_NAMES = ["thumb", "medium", "large"] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

export const VARIANT_FORMATS = ["avif", "webp", "jpeg"] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

const FORMAT_INFO: Record<VariantFormat, { mime: string; extension: string }> = {
  avif: { mime: "image/avif", extension: "avif" },
  webp: { mime: "image/webp", extension: "webp" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
};

export interface VariantSettings {
  thumbWidth: number;
  mediumWidth: number;
  largeWidth: number;
  avifQuality: number;
  webpQuality: number;
  jpegQuality: number;
  maxInputPixels: number;
}

export interface GeneratedVariant {
  name: VariantName;
  format: VariantFormat;
  mime: string;
  extension: string;
  width: number;
  height: number;
  buffer: Buffer;
  /** Primele 8 caractere din SHA-256: intră în cheie, ca un URL să nu-și schimbe niciodată conținutul. */
  hash: string;
}

export interface GeneratedImage {
  /** Dimensiunile imaginii după orientare. */
  width: number;
  height: number;
  blurhash: string;
  variants: GeneratedVariant[];
}

/**
 * Din originalul curățat generează variantele (thumb/medium/large × AVIF/WebP/JPEG) și blurhash.
 * Limita de pixeli se aplică și aici (nu doar la upload): setarea poate fi coborâtă între timp,
 * iar regenerarea nu are voie să decodeze o imagine peste limită.
 *
 * Variantele nu măresc imaginea: dacă o lățime țintă e ≥ lățimea originalului, se generează o
 * singură dată, la dimensiunea originalului (prima mărime care o depășește); următoarele se sar.
 * Apelantul ține un loc din limita globală de decodări cât durează apelul.
 */
export async function generateVariants(
  original: Buffer,
  settings: VariantSettings,
): Promise<GeneratedImage> {
  // Import leneș (modul nativ): vezi `sanitizeImage`.
  const [{ default: sharp }, { encode }] = await Promise.all([import("sharp"), import("blurhash")]);
  const open = () =>
    sharp(original, { limitInputPixels: settings.maxInputPixels, failOn: "error" }).rotate();

  let meta;
  try {
    meta = await sharp(original, {
      limitInputPixels: settings.maxInputPixels,
      failOn: "error",
    }).metadata();
  } catch (error) {
    throw classify(error, settings.maxInputPixels);
  }
  const srcWidth = meta.width;
  const srcHeight = meta.height;
  if (!srcWidth || !srcHeight) throw new MediaError("MEDIA_CORRUPT", "Imaginea nu are dimensiuni");
  if (srcWidth * srcHeight > settings.maxInputPixels) {
    throw new MediaError("MEDIA_IMAGE_TOO_BIG", "Imaginea are prea mulți pixeli");
  }
  const swapped = (meta.orientation ?? 1) >= 5;
  const orientedWidth = swapped ? srcHeight : srcWidth;
  const orientedHeight = swapped ? srcWidth : srcHeight;

  const targets: [VariantName, number][] = [
    ["thumb", settings.thumbWidth],
    ["medium", settings.mediumWidth],
    ["large", settings.largeWidth],
  ];
  targets.sort((a, b) => a[1] - b[1]);

  const variants: GeneratedVariant[] = [];
  try {
    let atOriginalWidth = false;
    for (const [name, target] of targets) {
      if (target >= orientedWidth) {
        if (atOriginalWidth) continue;
        atOriginalWidth = true;
      }
      const width = Math.min(target, orientedWidth);
      for (const format of VARIANT_FORMATS) {
        let pipeline = open().resize({ width, withoutEnlargement: true });
        if (format === "avif") {
          pipeline = pipeline.avif({ quality: settings.avifQuality, effort: 3 });
        } else if (format === "webp") {
          pipeline = pipeline.webp({ quality: settings.webpQuality });
        } else {
          // JPEG nu are transparență: o așezăm pe alb (altfel devine negru).
          pipeline = pipeline
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: settings.jpegQuality, mozjpeg: true });
        }
        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        variants.push({
          name,
          format,
          ...FORMAT_INFO[format],
          width: info.width,
          height: info.height,
          buffer: data,
          hash: createHash("sha256").update(data).digest("hex").slice(0, 8),
        });
      }
    }

    const tiny = await open()
      .resize(32, 32, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const blurhash = encode(
      new Uint8ClampedArray(tiny.data),
      tiny.info.width,
      tiny.info.height,
      4,
      3,
    );

    return { width: orientedWidth, height: orientedHeight, blurhash, variants };
  } catch (error) {
    throw classify(error, settings.maxInputPixels);
  }
}

function classify(error: unknown, maxInputPixels: number): MediaError {
  if (error instanceof MediaError) return error;
  if (error instanceof Error && /pixel limit/i.test(error.message)) {
    return new MediaError("MEDIA_IMAGE_TOO_BIG", "Imaginea are prea mulți pixeli", {
      maxInputPixels,
    });
  }
  return new MediaError("MEDIA_CORRUPT", "Imaginea nu poate fi procesată");
}
