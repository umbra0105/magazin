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
