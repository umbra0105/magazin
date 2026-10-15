import { revalidateTag } from "next/cache";
import {
  AttributeService,
  BrandService,
  CategoryService,
  ProductAttributesService,
  ProductRelationsService,
  ProductAssignmentsService,
  ProductListService,
  ProductService,
  createPrismaAttributeStore,
  createPrismaBrandStore,
  createPrismaCategoryStore,
  createPrismaProductAttributeStore,
  createPrismaProductRelationStore,
  createPrismaProductAssignmentStore,
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
  __ecomAssignments?: ProductAssignmentsService;
  __ecomAttributes?: AttributeService;
  __ecomProductAttributes?: ProductAttributesService;
  __ecomRelations?: ProductRelationsService;
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
    defaultWarrantyMonths: async () =>
      (await getSettings().getGroup("catalog")).defaultWarrantyMonths,
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

/** Categoriile și imaginile unui produs (taburile Categorii și Media din editor). */
export function getProductAssignmentsService(): ProductAssignmentsService {
  globalForCatalog.__ecomAssignments ??= new ProductAssignmentsService({
    store: createPrismaProductAssignmentStore(getDb()),
    audit: getAudit(),
    storage: getStorage(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomAssignments;
}

/** Definițiile atributelor (pagina Atribute). Un singur serviciu per proces. */
export function getAttributeService(): AttributeService {
  globalForCatalog.__ecomAttributes ??= new AttributeService({
    store: createPrismaAttributeStore(getDb()),
    audit: getAudit(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomAttributes;
}

/** Valorile atributelor pe produs (tabul Atribute). */
export function getProductAttributesService(): ProductAttributesService {
  globalForCatalog.__ecomProductAttributes ??= new ProductAttributesService({
    store: createPrismaProductAttributeStore(getDb()),
    attributes: createPrismaAttributeStore(getDb()),
    audit: getAudit(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomProductAttributes;
}

/** Relațiile dintre produse (tabul Asociate). */
export function getProductRelationsService(): ProductRelationsService {
  globalForCatalog.__ecomRelations ??= new ProductRelationsService({
    store: createPrismaProductRelationStore(getDb()),
    audit: getAudit(),
    invalidate,
    logger: getLogger(),
  });
  return globalForCatalog.__ecomRelations;
}
