import type { StorageDriver } from "@ecom/integrations";
import type { StoredVariant } from "./processing";
import type { VariantName } from "./variants";

export interface MediaUrlSource {
  storageKey: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  variants: unknown;
}

export interface MediaVariantUrl {
  name: string;
  format: string;
  mime: string;
  width: number;
  height: number;
  url: string;
}

export interface MediaUrls {
  /** Originalul curățat (fără EXIF). */
  original: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  variants: MediaVariantUrl[];
  /** `srcset` gata de folosit, pe format: `{ avif: "url 320w, url 800w", webp: …, jpeg: … }`. */
  srcset: Record<string, string>;
}

function parseVariants(value: unknown): StoredVariant[] {
  return Array.isArray(value) ? (value as StoredVariant[]) : [];
}

export interface PickedImage {
  url: string;
  width: number;
  height: number;
}

/** Ordinea preferinței formatului pentru un `<img>` simplu (fără `<picture>`): WebP, apoi JPEG, apoi AVIF. */
const FORMAT_PREFERENCE = ["webp", "jpeg", "avif"] as const;

/**
 * O singură variantă generată (nu originalul), în formatul cel mai potrivit pentru un `<img>`; `null` cât timp fișierul nu a fost
 * procesat (vitrina nu servește niciodată originalul necomprimat). Singurul loc care alege varianta pentru carduri, plăci de
 * meniu și galerii.
 */
export function pickVariantImage(
  media: MediaUrlSource,
  storage: StorageDriver,
  name: VariantName,
): PickedImage | null {
  const named = buildMediaUrls(media, storage).variants.filter((v) => v.name === name);
  for (const format of FORMAT_PREFERENCE) {
    const found = named.find((v) => v.format === format);
    if (found) return { url: found.url, width: found.width, height: found.height };
  }
  return null;
}

/** Ordinea de rezervă când varianta cerută lipsește: cea mai apropiată ca mărime (nu se generează variante mai mari decât originalul). */
const SIZE_FALLBACK: Readonly<Record<VariantName, readonly VariantName[]>> = {
  large: ["large", "medium", "thumb"],
  medium: ["medium", "large", "thumb"],
  thumb: ["thumb", "medium", "large"],
};

/**
 * Ca `pickVariantImage`, dar când varianta cerută nu există (un original mic nu primește «large») folosește cea mai apropiată
 * disponibilă. `null` doar când fișierul nu are nicio variantă procesată: vitrina nu servește niciodată originalul necomprimat.
 */
export function pickBestVariantImage(
  media: MediaUrlSource,
  storage: StorageDriver,
  preferred: VariantName,
): PickedImage | null {
  for (const name of SIZE_FALLBACK[preferred]) {
    const picked = pickVariantImage(media, storage, name);
    if (picked) return picked;
  }
  return null;
}

/**
 * URL-urile publice ale unui fișier media: toate trec prin `storage.publicUrl`, deci arată corect
 * pe orice configurație (`/media/...` pe aplicație, sau `S3_PUBLIC_URL` pe CDN / bucket public).
 * Singurul loc din care paginile iau adrese de imagini.
 */
export function buildMediaUrls(media: MediaUrlSource, storage: StorageDriver): MediaUrls {
  const variants = parseVariants(media.variants)
    .map((v) => ({
      name: v.name,
      format: v.format,
      mime: v.mime,
      width: v.width,
      height: v.height,
      url: storage.publicUrl(v.key),
    }))
    .sort((a, b) => a.width - b.width);

  const srcset: Record<string, string> = {};
  for (const format of new Set(variants.map((v) => v.format))) {
    srcset[format] = variants
      .filter((v) => v.format === format)
      .map((v) => `${v.url} ${v.width}w`)
      .join(", ");
  }

  return {
    original: storage.publicUrl(media.storageKey),
    width: media.width,
    height: media.height,
    blurhash: media.blurhash,
    variants,
    srcset,
  };
}
