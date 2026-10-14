/**
 * Valorile permise pentru câmpurile de tip enum din catalog. Coloanele sunt `TEXT` cu constrângeri
 * CHECK în migrația `catalog_core`; aici e singura listă din cod (testul de integrare verifică
 * potrivirea cu baza).
 */
export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_TYPES = ["physical", "digital"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * Clasa de transport a produsului. `oversized` și `pallet` nu merg la easybox. Regulile de preț și de
 * curier pe clase se stabilesc la Faza 12; aici e doar marcajul.
 */
export const SHIPPING_CLASSES = ["standard", "oversized", "pallet"] as const;
export type ShippingClass = (typeof SHIPPING_CLASSES)[number];

export const STOCK_STATUSES = ["instock", "outofstock", "onbackorder"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const COST_PRICE_SOURCES = ["manual", "import"] as const;
export type CostPriceSource = (typeof COST_PRICE_SOURCES)[number];

export const PRODUCT_DOCUMENT_TYPES = [
  "energy_label",
  "product_sheet",
  "manual",
  "ce_declaration",
  "datasheet",
  "warranty",
  "other",
] as const;
export type ProductDocumentType = (typeof PRODUCT_DOCUMENT_TYPES)[number];

/** Tipurile de fișier acceptate pentru documente (verificate din octeți la încărcare, punctul 11). */
export const PRODUCT_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Clasele energetice acceptate: scara veche (A+++ … D) și cea nouă (A … G). */
export const ENERGY_CLASSES = ["A+++", "A++", "A+", "A", "B", "C", "D", "E", "F", "G"] as const;
export type EnergyClass = (typeof ENERGY_CLASSES)[number];

export const COLLECTION_TYPES = ["manual", "automated"] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];

export const ATTRIBUTE_TYPES = ["text", "number", "select", "bool"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/**
 * Tipurile de relație între produse. `productId` e produsul principal, `relatedProductId` cel asociat;
 * `spare_part` = piesa de schimb a principalului, `compatible_with` = principalul e compatibil cu cel
 * asociat.
 */
export const PRODUCT_RELATION_TYPES = [
  "similar",
  "accessory",
  "upsell",
  "crosssell",
  "spare_part",
  "compatible_with",
] as const;
export type ProductRelationType = (typeof PRODUCT_RELATION_TYPES)[number];
