import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pickVariantImage } from "@ecom/core";
import { getDb } from "@ecom/db";

/**
 * Imaginile de demonstrație ale galeriei de design (doar dezvoltare; vezi `page.e2e.tsx`). Două surse, ambele opționale:
 *  - fotografiile produselor demo din baza de dezvoltare (varianta `medium` procesată, prin același cod ca vitrina);
 *  - o fotografie pentru hero, din folderul local `local-data/foto-hero/` (ignorat de git, nu se comite niciodată).
 * Fără ele (de exemplu pe baza goală din CI) galeria folosește substituenți plați, fără degrade: nimic nu pică.
 */

/** GIF transparent 1×1: tiparul pentru plăcile de meniu când nu există nicio fotografie (se vede fundalul plat al plăcii). */
export const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export interface DemoPhoto {
  src: string;
  width: number;
  height: number;
  alt: string;
}

const HERO_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Plafon pentru fotografia încorporată în pagină (data URI): peste el se ignoră, ca pagina de dezvoltare să rămână rapidă. */
export const HERO_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Prima fotografie (în ordinea numelor) din folder, ca `data:` URI; `null` dacă folderul lipsește, e gol sau nu conține o
 * imagine acceptată (jpg, png, webp) sub plafon. Dimensiunile sunt nominale (hero-ul umple tot spațiul, `object-cover`).
 */
export async function pickHeroPhoto(dir: string): Promise<DemoPhoto | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
  for (const name of names) {
    const mime = HERO_EXTENSIONS[extname(name).toLowerCase()];
    if (!mime) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0 || info.size > HERO_MAX_BYTES) continue;
      const data = await readFile(file);
      return {
        src: `data:${mime};base64,${data.toString("base64")}`,
        width: 1600,
        height: 900,
        alt: "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Folderul fotografiilor de hero: la rădăcina depozitului, indiferent dacă serverul rulează din rădăcină sau din `apps/web`. */
export function heroPhotoDirs(cwd: string): string[] {
  return [resolve(cwd, "local-data/foto-hero"), resolve(cwd, "../../local-data/foto-hero")];
}

export async function loadHeroPhoto(): Promise<DemoPhoto | null> {
  for (const dir of heroPhotoDirs(process.cwd())) {
    const found = await pickHeroPhoto(dir);
    if (found) return found;
  }
  return null;
}

/**
 * Până la `limit` fotografii ale produselor demo (câte una pe produs, cele mai recent modificate întâi). Citește prin același
 * `pickVariantImage` ca meniul. Orice eroare (bază indisponibilă, driver de stocare neconfigurat) întoarce lista goală.
 */
export async function loadDemoProductPhotos(limit: number): Promise<DemoPhoto[]> {
  try {
    const { getStorage } = await import("@/lib/media");
    const storage = getStorage();
    const rows = await getDb().productMedia.findMany({
      where: { variantId: null, media: { status: "ready" }, product: { deletedAt: null } },
      orderBy: [{ product: { updatedAt: "desc" } }, { position: "asc" }],
      take: limit * 8,
      select: {
        productId: true,
        product: { select: { title: true } },
        media: {
          select: { storageKey: true, width: true, height: true, blurhash: true, variants: true },
        },
      },
    });
    const seen = new Set<string>();
    const photos: DemoPhoto[] = [];
    for (const row of rows) {
      if (seen.has(row.productId)) continue;
      const picked = pickVariantImage(row.media, storage, "medium");
      if (!picked) continue;
      seen.add(row.productId);
      photos.push({
        src: picked.url,
        width: picked.width,
        height: picked.height,
        alt: row.product.title,
      });
      if (photos.length >= limit) break;
    }
    return photos;
  } catch {
    return [];
  }
}
