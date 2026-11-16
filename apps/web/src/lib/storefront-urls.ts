import { DEFAULT_LISTING_SORT, type ListingSort } from "@ecom/core";

/**
 * Adresele publice ale catalogului (`docs/03` §1): un singur loc, ca legăturile, canonicul, sitemap-ul și redirecționările să
 * fie mereu aceleași. Produsul are o singură adresă, `/produs/<slug>` (fără categorie în ea).
 */

export const SHOP_PATH = "/magazin";

export const productHref = (slug: string): string => `/produs/${slug}`;
export const categoryHref = (path: string): string => `/categorie/${path}`;

/**
 * Adresa unei liste cu sortare și pagină. Valorile implicite NU se scriu (sortarea implicită, pagina 1): adresa fără parametri
 * e forma canonică a primei pagini, deci nu există două adrese cu același conținut.
 */
export function listingHref(
  base: string,
  options: { sort?: ListingSort; page?: number } = {},
): string {
  const params = new URLSearchParams();
  if (options.sort && options.sort !== DEFAULT_LISTING_SORT) params.set("sortare", options.sort);
  if (options.page && options.page > 1) params.set("pagina", String(options.page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
