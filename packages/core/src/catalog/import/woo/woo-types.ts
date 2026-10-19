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
  /** Imaginile din coloana «Imagini» se descarcă în fundal, după produse (cere `media.write`). */
  importImages: boolean;
}

export const REPORT_IMAGE_ISSUES = 200;

export interface WooImagePolicy {
  allowedHosts: readonly string[];
  maxUrlLength: number;
  maxImagesPerProduct: number;
  maxImagesPerImport: number;
}

export interface WooContext {
  /** Politica imaginilor; `null` = importul de imagini oprit (opțiune dezactivată sau fără drept de media). */
  images: WooImagePolicy | null;
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
  /** Hash-ul adresei sursă → fișierul din bibliotecă adus deja de la acea adresă. */
  mediaBySourceHash: Map<string, string>;
  /** Fișierele media deja atașate fiecărui produs existent. */
  productMedia: Map<string, Set<string>>;
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

/** O imagine acceptată de verificările fără rețea, de adus în fundal după produse. */
export interface WooImageTask {
  row: number;
  /** SKU-ul primei variante a produsului (cu el se regăsește produsul după aplicare). */
  sku: string;
  position: number;
  /** Adresa NORMALIZATĂ (https, gazdă permisă). */
  url: string;
  sourceHash: string;
  host: string;
}

/** O imagine respinsă fără rețea (domeniu nepermis, http, port, IP...). Adresa brută NU se păstrează. */
export interface WooImageIssue {
  row: number;
  sku: string;
  position: number;
  host: string | null;
  reason: string;
  /** Hash-ul adresei brute, doar pentru deduplicare. */
  rawHash: string;
}

export interface WooImagePlan {
  enabled: boolean;
  tasks: WooImageTask[];
  issues: WooImageIssue[];
  stats: {
    total: number;
    accepted: number;
    rejected: number;
    /** Fișiere deja aduse de la aceeași adresă (se atașează fără descărcare). */
    alreadyInLibrary: number;
    /** Deja atașate produsului: nimic de făcut. */
    alreadyAttached: number;
    /** Imagini de pe rândurile de variație: se ignoră (se folosesc cele ale produsului variabil). */
    ignoredOnVariations: number;
    byHost: Record<string, number>;
    rejectedByReason: Record<string, number>;
  };
}

export interface WooPlanExtras {
  images: WooImagePlan;
  creations: WooCreations;
  refs: WooRefs;
  stats: WooStats;
  rowTypes: Record<string, number>;
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}

/** Secțiunea raportului specifică profilului WooCommerce. */
export interface WooReportSection {
  /** Imaginile din fișier: câte, de pe ce domenii, câte respinse și de ce (fără adrese). */
  images?: {
    enabled: boolean;
    stats: WooImagePlan["stats"];
    /** Imaginile respinse fără rețea, cu motivul în română (fără adrese); tăiat la `REPORT_IMAGE_ISSUES`. */
    issues: { row: number; sku: string; host: string | null; message: string }[];
    issuesTruncated: boolean;
  };
  categoriesToCreate: string[];
  brandsToCreate: string[];
  attributesToCreate: string[];
  stats: WooStats;
  rowTypes: Record<string, number>;
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}
