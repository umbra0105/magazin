import {
  DEFAULT_LISTING_SORT,
  filtersToParams,
  type ListingFilters,
  type ListingSort,
} from "@ecom/core";

/**
 * Adresele publice ale catalogului (`docs/03` §1): un singur loc, ca legăturile, canonicul, sitemap-ul și redirecționările să
 * fie mereu aceleași. Produsul are o singură adresă, `/produs/<slug>` (fără categorie în ea).
 */

export const SHOP_PATH = "/magazin";
export const SEARCH_PATH = "/cautare";

export const productHref = (slug: string): string => `/produs/${slug}`;
export const categoryHref = (path: string): string => `/categorie/${path}`;
export const brandHref = (slug: string): string => `/brand/${slug}`;
export const collectionHref = (slug: string): string => `/colectie/${slug}`;

/**
 * Adresa unei liste cu sortare, filtre și pagină. Valorile implicite NU se scriu (sortarea implicită, pagina 1, niciun filtru):
 * adresa fără parametri e forma canonică a primei pagini, deci nu există două adrese cu același conținut. Filtrele au ordine stabilă.
 */
export function listingHref(
  base: string,
  options: {
    sort?: ListingSort;
    page?: number;
    filters?: ListingFilters;
    /** Textul căutat (pagina de căutare): primul parametru din adresă. */
    query?: string;
  } = {},
): string {
  const params = new URLSearchParams();
  if (options.query) params.set("q", options.query);
  for (const [name, value] of options.filters ? filtersToParams(options.filters) : []) {
    params.set(name, value);
  }
  if (options.sort && options.sort !== DEFAULT_LISTING_SORT) params.set("sortare", options.sort);
  if (options.page && options.page > 1) params.set("pagina", String(options.page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
