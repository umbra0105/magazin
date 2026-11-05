import type { PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { buildMediaUrls } from "../../media/urls";
import type { MediaResolver, RenderedMedia } from "./render";

/** Formatele în ordinea preferinței pentru imaginile din descriere (un singur format într-un `srcset` simplu). */
const FORMAT_PREFERENCE = ["webp", "jpeg"] as const;
/** Lățimea țintă a imaginii implicite din descriere (cea mai mică variantă care o atinge). */
const TARGET_WIDTH = 800;

/**
 * Adresele imaginilor din descriere, din biblioteca media: adresa nu vine niciodată din HTML, ci din fișierul identificat
 * de `data-media-id`. Fișierele inexistente, de alt tip sau eșuate lipsesc din rezultat (imaginea dispare din pagină).
 */
export function createDbMediaResolver(
  db: Pick<PrismaClient, "media">,
  storage: StorageDriver,
): MediaResolver {
  return async (ids) => {
    const out = new Map<string, RenderedMedia>();
    if (ids.length === 0) return out;
    const rows = await db.media.findMany({
      where: { id: { in: [...ids] }, mime: { startsWith: "image/" }, status: { not: "failed" } },
      select: {
        id: true,
        storageKey: true,
        width: true,
        height: true,
        blurhash: true,
        variants: true,
      },
    });
    for (const row of rows) {
      const urls = buildMediaUrls(row, storage);
      const formats = [...new Set(urls.variants.map((variant) => variant.format))];
      const format =
        FORMAT_PREFERENCE.find((candidate) => formats.includes(candidate)) ?? formats[0];
      const variants = urls.variants.filter((variant) => variant.format === format);
      const chosen =
        variants.find((variant) => variant.width >= TARGET_WIDTH) ?? variants[variants.length - 1];
      out.set(row.id, {
        src: chosen ? chosen.url : urls.original,
        srcset: chosen && format ? (urls.srcset[format] ?? null) : null,
        width: urls.width,
        height: urls.height,
      });
    }
    return out;
  };
}
