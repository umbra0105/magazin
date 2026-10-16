import type { ShippingClass } from "../../constants";
import type { DimensionUnit, WeightUnit } from "./woo-values";

/**
 * Tipurile profilului WooCommerce: opțiunile alese la verificare, instantaneul catalogului, operațiile
 * planificate și secțiunea din raport. Operațiile referă categorii, branduri și atribute prin CHEI (numele
 * normalizat), nu prin id: cele care nu există încă se creează la aplicare, apoi cheile se rezolvă.
 */

export interface WooOptions {
  /** Produsele NOI intră ca ciornă; cu `true` se păstrează starea din fișier (publicat → activ). */
  keepStatus: boolean;
  weightUnit: WeightUnit;
  dimensionUnit: DimensionUnit;
  /** Numele clasei din WooCommerce (normalizat) → clasa de livrare a aplicației. */
  shippingClassMap: Record<string, ShippingClass>;
  /** Numele atributului (normalizat) → id al unui atribut existent, «create» sau «ignore». */
  attributeTargets: Record<string, string>;
}

export interface WooContext {
  timezone: string;
  /** Contul are `catalog.legacy.edit`: doar atunci se salvează ID-ul din magazinul vechi. */
  canSetLegacy: boolean;
}

export interface WooAttributeDef {
  id: string;
  code: string;
  name: string;
  type: "text" | "number" | "select" | "bool";
  options: { id: string; value: string }[];
}

export interface WooVariantExtra {
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  legacyId: string | null;
}

/** Ce există deja, în plus față de instantaneul generic (SKU-uri, categorii, branduri). */
export interface WooSnapshotExtras {
  categories: { id: string; name: string; parentId: string | null }[];
  brands: { id: string; name: string }[];
  attributes: WooAttributeDef[];
  variants: Map<string, WooVariantExtra>;
  products: Map<
    string,
    {
      legacyId: string | null;
      /** Valoarea atributelor în forma de comparare (text, zecimal canonic, «true»/«false», id de opțiune). */
      attributes: Map<string, string>;
      /** «upsell|<idProdus>» / «crosssell|<idProdus>». */
      relations: Set<string>;
    }
  >;
  productIdBySku: Map<string, string>;
  productIdByLegacyId: Map<string, string>;
  variantIdByLegacyId: Map<string, string>;
}

export interface WooAttributeDraft {
  /** Cheia atributului din fișier (nume normalizat). */
  key: string;
  /** Valoarea în forma pe care o așteaptă serviciul de atribute: text, zecimal, bool sau id de opțiune. */
  value: string | boolean;
}

export interface WooRelationDraft {
  type: "upsell" | "crosssell";
  /** Ținta: un SKU (al unei variante din fișier sau din catalog) sau un ID din magazinul vechi. */
  target: { sku: string } | { legacyId: string };
}

export interface WooVariantDraft {
  sku: string;
  price: number;
  salePrice: number | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  ean: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  legacyId: string | null;
  /** Valoarea fiecărei opțiuni (doar la produsele variabile). */
  selections: { option: string; value: string }[];
}

export interface WooProductDraft {
  title: string;
  subtitle: string | null;
  description: string | null;
  status: "draft" | "active";
  shippingClass: ShippingClass;
  brandKey: string | null;
  categoryKeys: string[];
}

export interface WooCreateOp {
  kind: "woo-create";
  product: WooProductDraft;
  variants: WooVariantDraft[];
  options: { name: string; values: string[] }[];
  attributeValues: WooAttributeDraft[];
  relations: WooRelationDraft[];
  legacyId: string | null;
  /** Rândurile din fișier ale variațiilor, create odată cu produsul. */
  childRows: number[];
}

export interface WooUpdateOp {
  kind: "woo-update";
  productId: string;
  variantId: string | null;
  productPatch: Record<string, unknown> | null;
  /** `undefined` = neschimbat; `null` = fără brand. */
  brandKey?: string | null;
  categoryKeys?: string[];
  variantPatch: Record<string, unknown> | null;
  legacyProduct: string | null;
  legacyVariant: string | null;
  attributeValues: WooAttributeDraft[];
  relations: WooRelationDraft[];
}

/** Variație creată odată cu produsul variabil (rândul părintelui o aplică). */
export interface WooChildOp {
  kind: "woo-child";
  parentRow: number;
}

export type WooOperation = WooCreateOp | WooUpdateOp | WooChildOp;

export interface WooStats {
  categoriesToCreate: number;
  brandsToCreate: number;
  attributesToCreate: number;
  /** Rânduri cu o clasă de livrare necunoscută (primesc «standard» sau rămân neschimbate). */
  unknownShippingClasses: number;
  descriptionsSanitized: number;
  descriptionTables: number;
  descriptionLinks: number;
  descriptionImages: number;
  descriptionShortcodes: number;
  /** Variații (rânduri «variation») planificate. */
  variations: number;
  unresolvedRelations: number;
  /** Produse fără SKU, cărora li s-a dat «WC-<ID>». */
  skuFallbacks: number;
  /** Rânduri cu ID din magazinul vechi care nu se salvează (lipsește `catalog.legacy.edit` sau există deja). */
  legacyNotSaved: number;
}

export interface WooCreations {
  /** Părinții înaintea copiilor. `names` = nivelurile căii, `key` = calea normalizată. */
  categories: { key: string; names: string[] }[];
  brands: { key: string; name: string }[];
  attributes: { key: string; name: string; code: string }[];
}

/** Id-urile entităților EXISTENTE referite de plan (cheie → id). */
export interface WooRefs {
  categoryId: Record<string, string>;
  brandId: Record<string, string>;
  attributeId: Record<string, string>;
}

export interface WooPlanExtras {
  creations: WooCreations;
  refs: WooRefs;
  stats: WooStats;
  rowTypes: Record<string, number>;
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}

/** Secțiunea raportului specifică profilului WooCommerce. */
export interface WooReportSection {
  categoriesToCreate: string[];
  brandsToCreate: string[];
  attributesToCreate: string[];
  stats: WooStats;
  rowTypes: Record<string, number>;
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}
