/**
 * Parametrii listelor din vitrină (categorie, mărci, colecții, magazin): sortarea și pagina din adresă. Funcții pure; orice
 * valoare necunoscută cade pe implicit (o adresă greșită nu produce eroare, ci prima pagină cu sortarea implicită).
 */

export const LISTING_SORTS = ["recommended", "new", "price_asc", "price_desc", "name_asc"] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];
export const DEFAULT_LISTING_SORT: ListingSort = "recommended";

export const MAX_LISTING_PAGE = 1000;

export function parseListingSort(value: unknown): ListingSort {
  return typeof value === "string" && (LISTING_SORTS as readonly string[]).includes(value)
    ? (value as ListingSort)
    : DEFAULT_LISTING_SORT;
}

/** Numărul paginii din adresă (`?pagina=3`): întreg ≥ 1; orice altceva → 1. */
export function parseListingPage(value: unknown): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,3}$/.test(text)) return 1;
  return Math.min(Number(text), MAX_LISTING_PAGE);
}

export interface PageWindow {
  page: number;
  pageCount: number;
  offset: number;
}

/**
 * Pagina cerută față de total: o pagină peste capăt NU se «repară» în tăcere (ar crea mai multe adrese cu același conținut):
 * `outOfRange` îi spune paginii să răspundă cu 404. O listă goală are o singură pagină (prima).
 */
export function pageWindow(
  page: number,
  total: number,
  pageSize: number,
): PageWindow & { outOfRange: boolean } {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return { page, pageCount, offset: (page - 1) * pageSize, outOfRange: page > pageCount };
}
