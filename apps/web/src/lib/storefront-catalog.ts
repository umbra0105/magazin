import { unstable_cache } from "next/cache";
import {
  CATALOG_TAG,
  CatalogReader,
  STOREFRONT_CHROME_TAG,
  type CatalogSettings,
  type ListingScope,
  type ListingSort,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getStorage } from "./media";
import { formatMoney } from "./money-input";
import { getSettings } from "./services";

const globalForReader = globalThis as unknown as { __ecomCatalogReader?: CatalogReader };

/** Cititorul public al catalogului (un singur exemplar per proces). */
export function getCatalogReader(): CatalogReader {
  globalForReader.__ecomCatalogReader ??= new CatalogReader({ db: getDb(), storage: getStorage() });
  return globalForReader.__ecomCatalogReader;
}

export interface StorefrontFormat extends CatalogSettings {
  currency: string;
  locale: string;
}

async function readFormat(): Promise<StorefrontFormat> {
  const settings = getSettings();
  const [catalog, inventory, regional] = await Promise.all([
    settings.getGroup("catalog"),
    settings.getGroup("inventory"),
    settings.getGroup("regional"),
  ]);
  return {
    showSalePricing: catalog.showSalePricing,
    productsPerPage: catalog.productsPerPage,
    lowStockSteps: inventory.lowStockSteps,
    defaultLeadTimeDays: inventory.defaultLeadTimeDays,
    currency: regional.currency,
    locale: regional.locale,
  };
}

/**
 * Setările de care depinde afișarea catalogului (preț, stoc, moneda). În cache cu aceleași etichete ca restul vitrinei: se
 * schimbă la salvarea unei setări (`AdminWrites` invalidează `storefront-chrome` și `catalog`).
 */
export const getStorefrontFormat = unstable_cache(readFormat, ["storefront-format"], {
  tags: [STOREFRONT_CHROME_TAG, CATALOG_TAG],
  revalidate: 300,
});

const CACHE = { tags: [CATALOG_TAG], revalidate: 60 };

/**
 * Citirile catalogului pentru paginile care folosesc `searchParams` (sortare, pagină) și deci nu pot fi pagini statice: rezultatul
 * stă în cache-ul de date, cu eticheta `catalog` (invalidată de serviciile de catalog, de import, de media și de scrierile din admin),
 * cheia fiind parametrii cererii. O plasă de timp de 60 s acoperă ce n-a putut fi invalidat (de exemplu stocul).
 */
export const listProductsCached = unstable_cache(
  (
    scope: ListingScope,
    sort: ListingSort,
    offset: number,
    limit: number,
    format: StorefrontFormat,
  ) => getCatalogReader().listProducts(scope, { sort, offset, limit }, format),
  ["catalog-listing"],
  CACHE,
);

export const getCategoryCached = unstable_cache(
  (path: string) => getCatalogReader().getCategory(path),
  ["catalog-category"],
  CACHE,
);

export const getProductCached = unstable_cache(
  (slug: string, format: StorefrontFormat) => getCatalogReader().getProduct(slug, format),
  ["catalog-product"],
  CACHE,
);

export function formatPrice(minor: number, format: Pick<StorefrontFormat, "currency" | "locale">) {
  return formatMoney(minor, format.currency, format.locale);
}

/** Cât timp o pagină de catalog poate fi servită din cache fără regenerare (secunde); invalidarea pe etichete o scurtează. */
export const CATALOG_REVALIDATE_SECONDS = 60;
