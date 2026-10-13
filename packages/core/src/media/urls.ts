import type { StorageDriver } from "@ecom/integrations";
import type { StoredVariant } from "./processing";

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
