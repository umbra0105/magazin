import { DomainError } from "@ecom/shared";

/** Erori de catalog cu cod stabil; mesajele sunt scrise pentru administrator și nu conțin valori sensibile. */
export class CatalogError extends DomainError {}

export const CATALOG_TAG = "catalog";

/**
 * Etichetele de cache care trebuie invalidate când se modifică un produs. Nucleul nu știe de Next:
 * aplicația le transmite lui `revalidateTag` printr-un callback (`invalidate`).
 */
export function productCacheTags(product: { id: string; slug: string }): string[] {
  return [CATALOG_TAG, `product:${product.id}`, `product-slug:${product.slug}`];
}

export interface PriceWindow {
  price: number;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

/**
 * Prețul public brut în vigoare la `at`: promoția dacă e activă (în fereastra ei, capătul final
 * exclusiv), altfel prețul întreg; niciodată mai mult decât prețul întreg.
 */
export function effectivePrice(variant: PriceWindow, at: Date): number {
  const { price, salePrice, saleStartsAt, saleEndsAt } = variant;
  if (salePrice === null) return price;
  const t = at.getTime();
  const started = saleStartsAt === null || saleStartsAt.getTime() <= t;
  const notEnded = saleEndsAt === null || t < saleEndsAt.getTime();
  return started && notEnded ? Math.min(price, salePrice) : price;
}

const LONG_TEXT = 200;

/**
 * Valoare sigură pentru jurnalul de audit: textele lungi (descrieri) devin un rezumat, ca jurnalul
 * să nu stocheze conținut întreg și să rămână lizibil.
 */
export function auditValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > LONG_TEXT) {
    return `[text de ${value.length} caractere]`;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Doar câmpurile care s-au schimbat, cu valoarea veche și cea nouă (în formă sigură pentru audit). */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<Record<keyof T, unknown>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const out = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const [key, next] of Object.entries(patch)) {
    if (next === undefined) continue;
    const prev = before[key];
    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : prev === next;
    if (same) continue;
    out.before[key] = auditValue(prev);
    out.after[key] = auditValue(next);
  }
  return out;
}
