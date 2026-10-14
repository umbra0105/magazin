/**
 * Interfața unui canal de vânzare extern (eMAG, Faza 22b). Aici există doar scheletul: contractul pe
 * care îl implementează adaptoarele din `packages/integrations`. Magazinul propriu (`web`) nu are
 * provider: oferta lui e catalogul. Cheile API ale canalului stau criptate în `Integration`.
 *
 * Sumele sunt `int` în bani. Metodele aruncă `IntegrationError` (cod stabil) la eșec; apelantul
 * (job în coadă, niciodată în tranzacție) decide reîncercarea.
 */

export interface ChannelListingRef {
  listingId: string;
  productId: string;
  variantId: string;
  /** ID-ul ofertei la canal, dacă a fost deja publicată. */
  externalId: string | null;
  /** Identificatorul produsului în catalogul canalului (eMAG: part_number_key). */
  externalProductKey: string | null;
}

export interface ChannelListingContent {
  ref: ChannelListingRef;
  /** Prețul brut (cu TVA) pe canal, în bani. */
  price: number;
  salePrice: number | null;
  stock: number;
  /** Datele de produs cerute la publicare (EAN și brand sunt obligatorii pe canalele care le cer). */
  ean: string | null;
  brandName: string | null;
  title: string;
  warrantyMonths: number | null;
}

export interface ChannelValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export interface PublishListingResult {
  externalId: string | null;
  externalProductKey: string | null;
  status: "pending" | "active" | "rejected";
  issues: readonly ChannelValidationIssue[];
}

export interface ChannelStockUpdate {
  ref: ChannelListingRef;
  stock: number;
}

export interface ChannelPriceUpdate {
  ref: ChannelListingRef;
  price: number;
  salePrice: number | null;
}

/** Comandă venită de la canal, în forma brută + câmpurile de care are nevoie importul. */
export interface ChannelOrder {
  externalId: string;
  placedAt: Date;
  raw: Readonly<Record<string, unknown>>;
}

export interface ChannelAwb {
  carrier: string;
  trackingNumber: string;
}

export interface ChannelInvoiceRef {
  number: string;
  /** PDF-ul facturii, ca URL semnat cu expirare scurtă. */
  pdfUrl: string;
}

export interface ChannelReturn {
  externalId: string;
  externalOrderId: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface ChannelProvider {
  /** Codul canalului (`SalesChannel.code`), ex. `emag`. */
  readonly code: string;
  publishListing(content: ChannelListingContent): Promise<PublishListingResult>;
  syncStock(updates: readonly ChannelStockUpdate[]): Promise<void>;
  syncPrice(updates: readonly ChannelPriceUpdate[]): Promise<void>;
  fetchOrders(since: Date): Promise<readonly ChannelOrder[]>;
  acknowledgeOrder(externalOrderId: string): Promise<void>;
  pushAwb(externalOrderId: string, awb: ChannelAwb): Promise<void>;
  pushInvoice(externalOrderId: string, invoice: ChannelInvoiceRef): Promise<void>;
  fetchReturns(since: Date): Promise<readonly ChannelReturn[]>;
}
