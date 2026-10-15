import { CatalogError } from "./catalog-support";
import { PRODUCT_TITLE_MAX_LENGTH, SKU_MAX_LENGTH } from "./product-schemas";

/**
 * Regulile pure ale ciclului de viață al produsului (duplicare, arhivare, ștergere): fără bază de date,
 * folosite de `ProductLifecycleService` și testate separat.
 */

/** Sufixul titlului unei copii. */
export const DUPLICATE_TITLE_SUFFIX = " (copie)";
/** Sufixul codului (SKU) unei copii; cât timp un SKU îl are, editorul îl arată ca „de completat”. */
export const DUPLICATE_SKU_SUFFIX = "-COPIE";

const COPY_SKU_PATTERN = /-COPIE(?:-\d+)?$/i;

/** Titlul copiei, tăiat ca sufixul să încapă în limita titlului. */
export function copyTitle(title: string): string {
  const room = PRODUCT_TITLE_MAX_LENGTH - DUPLICATE_TITLE_SUFFIX.length;
  return `${title.slice(0, room).trimEnd()}${DUPLICATE_TITLE_SUFFIX}`;
}

/** Codul are sufixul generat la duplicare, deci nu a fost încă completat de administrator. */
export function hasCopySkuMarker(sku: string): boolean {
  return COPY_SKU_PATTERN.test(sku);
}

const MAX_SKU_ATTEMPTS = 50;

/**
 * Codurile (SKU) unei copii: `<cod>-COPIE`, apoi `<cod>-COPIE-2`... aceeași treaptă pentru toate
 * variantele, până când niciunul nu e deja folosit (fără diferență de majuscule) și niciunul nu se
 * repetă între ele (tăierea la limita de lungime ar putea face două coduri identice).
 * `findTaken` întoarce dintre candidați pe cei deja existenți în bază.
 */
export async function copySkus(
  sources: readonly string[],
  findTaken: (candidates: readonly string[]) => Promise<readonly string[]>,
): Promise<string[]> {
  for (let attempt = 1; attempt <= MAX_SKU_ATTEMPTS; attempt++) {
    const suffix = attempt === 1 ? DUPLICATE_SKU_SUFFIX : `${DUPLICATE_SKU_SUFFIX}-${attempt}`;
    const seen = new Set<string>();
    const candidates = sources.map((sku, index) => {
      let candidate = `${sku.slice(0, SKU_MAX_LENGTH - suffix.length)}${suffix}`;
      if (seen.has(candidate.toLowerCase())) {
        // tăierea la limită a făcut două coduri identice: al doilea primește numărul poziției
        const position = `-${index + 1}`;
        candidate = `${sku.slice(0, SKU_MAX_LENGTH - suffix.length - position.length)}${position}${suffix}`;
      }
      seen.add(candidate.toLowerCase());
      return candidate;
    });
    if (seen.size !== candidates.length) continue;
    if ((await findTaken(candidates)).length === 0) return candidates;
  }
  throw new CatalogError(
    "CATALOG_SKU_CONFLICT",
    "Nu am găsit coduri (SKU) libere pentru copie; redu numărul de copii existente sau schimbă codurile",
  );
}

/**
 * Regula unică „se poate vinde”: produs activ și neșters. Storefront-ul (Faza 7) și canalele (Faza 18)
 * o folosesc ca produsul arhivat, ciornă sau șters să nu apară nicăieri.
 */
export function isSellable(product: { status: string; deletedAt: Date | null }): boolean {
  return product.status === "active" && product.deletedAt === null;
}
