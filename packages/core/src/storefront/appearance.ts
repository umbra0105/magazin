/**
 * Opțiunile de aspect ale vitrinei, alegeri dintr-o listă fixă (nu text liber): le citesc registrul de setări (validare la scriere),
 * cadrul vitrinei (ce variantă se desenează) și editorul de temă din admin (ce se oferă). Un singur loc, ca cele trei să nu
 * difere. Valorile sunt chei stabile, nu etichete (etichetele sunt în mesaje).
 */
export const HEADER_VARIANTS = ["default", "glass"] as const;
export type HeaderVariant = (typeof HEADER_VARIANTS)[number];

export const FOOTER_VARIANTS = ["default", "compact"] as const;
export type FooterVariant = (typeof FOOTER_VARIANTS)[number];

export const CONTAINER_WIDTHS = ["lg", "xl", "2xl"] as const;
export type ContainerWidth = (typeof CONTAINER_WIDTHS)[number];

/** Layout-ul cardului de produs: imagine sus (grilă) sau imagine în stânga (listă). */
export const CARD_LAYOUTS = ["vertical", "horizontal"] as const;
export type CardLayout = (typeof CARD_LAYOUTS)[number];

export const ANNOUNCEMENT_TONES = ["brand", "neutral"] as const;
export type AnnouncementTone = (typeof ANNOUNCEMENT_TONES)[number];

export const ANNOUNCEMENT_MAX_LENGTH = 200;

/** Destinația anunțului: cale locală (`/…`, nu `//…`) sau adresă `https://`; gol = fără link. Fără alte scheme (`javascript:`, `data:`). */
export function isSafeAnnouncementHref(value: string): boolean {
  if (value === "") return true;
  if (value.length > 300 || /[\s<>"'`\\]/.test(value)) return false;
  return /^\/(?!\/)/.test(value) || /^https:\/\/[^/]/.test(value);
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Valorile necunoscute (setări vechi, rânduri editate de mână) cad pe valoarea implicită: vitrina nu pică din cauza unei setări. */
export const headerVariantOf = (value: unknown): HeaderVariant =>
  pick(HEADER_VARIANTS, value, "default");
export const footerVariantOf = (value: unknown): FooterVariant =>
  pick(FOOTER_VARIANTS, value, "default");
export const containerWidthOf = (value: unknown): ContainerWidth =>
  pick(CONTAINER_WIDTHS, value, "xl");
export const cardLayoutOf = (value: unknown): CardLayout => pick(CARD_LAYOUTS, value, "vertical");
