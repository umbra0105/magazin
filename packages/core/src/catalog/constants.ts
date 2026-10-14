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
