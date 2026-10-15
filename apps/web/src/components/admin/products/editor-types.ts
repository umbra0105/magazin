/**
 * Tipurile datelor pe care pagina de server le dă editorului de produs (componente client). NICIUN
 * câmp de cost aici: prețul de achiziție se randează în componente de server și nu trece prin props.
 */

export interface EditorProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  status: string;
  brandId: string | null;
  shippingClass: string;
  requiresInstallation: boolean;
  excludeFromGroupDiscount: boolean;
  manageStock: boolean;
  stockStatus: string;
  seoTitle: string | null;
  seoDescription: string | null;
  energyClass: string | null;
  eprelUrl: string | null;
  gpsrManufacturerName: string | null;
  gpsrManufacturerContact: string | null;
  gpsrResponsibleName: string | null;
  gpsrResponsibleContact: string | null;
  safetyWarnings: string | null;
}

export interface EditorDocument {
  id: string;
  type: string;
  title: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  language: string;
  showInTab: boolean;
}

export interface EditorVariant {
  id: string;
  sku: string;
  ean: string | null;
  warrantyMonths: number | null;
  /** Bani, brut (cu TVA). */
  price: number;
  salePrice: number | null;
  /** „AAAA-LL-ZZTHH:mm” în ora magazinului, gata pentru `datetime-local`; `null` = fără limită. */
  saleStartsAtLocal: string | null;
  saleEndsAtLocal: string | null;
  isDefault: boolean;
  weightGrams: number | null;
  manufacturerPartNumber: string | null;
  /** Alegerile de opțiuni, ca text („Culoare: Alb”); gol la o variantă fără opțiuni. */
  label: string;
}

export interface EditorOption {
  name: string;
  values: string[];
}

export interface EditorAttribute {
  id: string;
  code: string;
  name: string;
  type: "text" | "number" | "select" | "bool";
  unit: string | null;
  isFilterable: boolean;
  options: { id: string; value: string }[];
  /** Text, număr canonic („12.5”), id de opțiune sau da/nu; `null` = necompletat. */
  value: string | boolean | null;
}

export interface EditorRelation {
  id: string;
  type: string;
  position: number;
  direction: "outgoing" | "incoming";
  product: { id: string; title: string; sku: string | null; status: string; deleted: boolean };
}

export interface EditorCaps {
  /** `products.write`: starea, prețul, stocul, livrarea, brandul, categoriile. */
  canWrite: boolean;
  /** `products.content.write`: titlu, adresă, descriere, SEO, imagini. */
  canContent: boolean;
}

export interface PickOption {
  id: string;
  label: string;
}

export interface EditorMediaItem {
  id: string;
  mediaId: string;
  name: string;
  alt: string;
  status: string;
  thumb: string | null;
}
