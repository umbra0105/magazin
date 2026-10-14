import { revalidateTag } from "next/cache";
import {
  BrandService,
  CategoryService,
  ProductListService,
  ProductService,
  createPrismaBrandStore,
  createPrismaCategoryStore,
  createPrismaProductListStore,
  createPrismaProductStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";
import { getStorage } from "./media";
import { getSettings } from "./services";

const globalForCatalog = globalThis as unknown as {
  __ecomCategories?: CategoryService;
  __ecomBrands?: BrandService;
  __ecomProducts?: ProductService;
  __ecomProductList?: ProductListService;
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

/**
 * Serviciul de produse (creare, modificare prin `ProductUpdateGuard`, variante, editare în masă).
 * `manageStock` implicit pentru produse noi vine din setarea `inventory.manageStock`.
 */
export function getProductService(): ProductService {
  globalForCatalog.__ecomProducts ??= new ProductService({
    store: createPrismaProductStore(getDb()),
    audit: getAudit(),
    defaultManageStock: async () => (await getSettings().getGroup("inventory")).manageStock,
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomProducts;
}

/** Lista de produse din admin (căutare, filtre, paginare; doar `thumb`, fără cost). */
export function getProductListService(): ProductListService {
  globalForCatalog.__ecomProductList ??= new ProductListService({
    store: createPrismaProductListStore(getDb()),
    storage: getStorage(),
  });
  return globalForCatalog.__ecomProductList;
}
