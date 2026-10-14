/** Rândul unei categorii, în forma trimisă la interfață (JSON simplu, fără cost sau date sensibile). */
export interface CategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
  /** Poziția între frați (0-based) și numărul de frați. */
  index: number;
  siblingCount: number;
  productCount: number;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  imageMediaId: string | null;
  excludeFromGroupDiscount: boolean;
  legacyId: string | null;
  legacyUrl: string | null;
  /** Părinții în care poate fi mutată (`null` = rădăcina), calculați pe server. */
  validParentIds: (string | null)[];
}

export interface CategoryCapabilities {
  /** `products.write`: creare, mutare, adresă, ștergere, excluderea de la discount. */
  structure: boolean;
  /** `products.content.write`: nume, descriere, SEO, imagine. */
  content: boolean;
  /** `catalog.legacy.edit`: legacyId, legacyUrl. */
  legacy: boolean;
  /** `media.read`: poate alege imaginea din bibliotecă. */
  pickMedia: boolean;
}
