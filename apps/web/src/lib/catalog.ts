import { revalidateTag } from "next/cache";
import {
  BrandService,
  CategoryService,
  createPrismaBrandStore,
  createPrismaCategoryStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";

const globalForCatalog = globalThis as unknown as {
  __ecomCategories?: CategoryService;
  __ecomBrands?: BrandService;
};

/**
 * Invalidarea de cache a catalogului: nucleul (`@ecom/core`) nu știe de Next și cheamă acest callback
 * cu etichetele afectate. Un eșec (ex. în afara unei cereri) nu anulează scrierea: serviciile îl loghează.
 */
async function invalidate(tags: readonly string[]): Promise<void> {
  for (const tag of tags) revalidateTag(tag);
}

/** Categoriile (arbore, mutări, ștergere). Un singur serviciu per proces. */
export function getCategoryService(): CategoryService {
  globalForCatalog.__ecomCategories ??= new CategoryService({
    store: createPrismaCategoryStore(getDb()),
    audit: getAudit(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomCategories;
}

/** Brandurile. Un singur serviciu per proces. */
export function getBrandService(): BrandService {
  globalForCatalog.__ecomBrands ??= new BrandService({
    store: createPrismaBrandStore(getDb()),
    audit: getAudit(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomBrands;
}
