import type { ConnectionTestResult } from "./payment-provider";

/**
 * Contractul curierilor (Faza 12): interfața `ShippingCarrier` pe care o implementează adaptoarele wootPRO, Sameday și DEMO.
 * Tipurile sunt doar de date simple (fără tipuri din `@ecom/core`), ca adaptoarele din `@ecom/integrations` să nu depindă de
 * logica de business. Sumele sunt `int` în bani, cu TVA inclus; greutățile în grame, dimensiunile în mm.
 *
 * Date personale: către curier pleacă DOAR ce cere AWB-ul (nume, telefon, adresă, ramburs); nimic din ele nu intră în loguri,
 * notificări sau mesaje de eroare (un adaptor nu pune niciodată în mesaj corpul cererii sau al răspunsului).
 */

export const SHIPPING_PROVIDER_CODES = ["wootpro", "sameday", "demo"] as const;
export type ShippingProviderCode = (typeof SHIPPING_PROVIDER_CODES)[number];

export const SHIPMENT_STATUSES = [
  "created",
  "picked_up",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export type ShippingMode = "test" | "live";

export interface CarrierParcel {
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface CarrierDestination {
  countyName: string;
  localityName: string;
  postalCode: string;
}

export interface CarrierQuoteRequest {
  parcels: readonly CarrierParcel[];
  destination: CarrierDestination;
  /** Suma de ramburs (bani); 0 dacă plata nu e rambursul. */
  codAmountMinor: number;
}

export interface CarrierQuote {
  /** Codul stabil al serviciului la curier (păstrat în snapshot-ul comenzii și refolosit la crearea AWB-ului). */
  serviceCode: string;
  courier: string;
  service: string;
  kind: "courier" | "easybox";
  priceMinor: number;
  estimatedDays: number | null;
  codFeeMinor: number;
}

export interface CarrierRecipient extends CarrierDestination {
  name: string;
  company?: string | null;
  phone: string;
  email?: string | null;
  street: string;
}

export interface CarrierAwbRequest {
  /** Referința noastră (numărul comenzii), trimisă curierului ca referință. */
  reference: string;
  recipient: CarrierRecipient;
  parcels: readonly CarrierParcel[];
  codAmountMinor: number;
  declaredValueMinor: number;
  observation?: string | null;
  /** Serviciul ales la checkout (`CarrierQuote.serviceCode`), dacă există. */
  serviceCode?: string | null;
  /** Punctul de ridicare ales (easybox), dacă există. */
  pickupPointId?: string | null;
}

/** Referința unui AWB la curier. */
export interface CarrierShipmentRef {
  awb: string;
  providerRef: string | null;
}

export interface CarrierAwbResult extends CarrierShipmentRef {
  trackingUrl: string | null;
  parcelCount: number;
}

export type LabelFormat = "pdf" | "zpl";

export interface CarrierLabel {
  format: LabelFormat;
  contentType: string;
  bytes: Uint8Array;
}

export interface CarrierTrackingEvent {
  /** Stabilă pentru același eveniment (idempotență): același eveniment primit de două ori are aceeași cheie. */
  key: string;
  code: string;
  label: string;
  occurredAt: Date;
  status: ShipmentStatus;
}

export interface CarrierTracking {
  /** Starea curentă normalizată (a ultimului eveniment cunoscut). */
  status: ShipmentStatus;
  events: readonly CarrierTrackingEvent[];
}

export interface CarrierPickupPoint {
  id: string;
  name: string;
  countyName: string;
  localityName: string;
  address: string;
}

/**
 * Un curier sau agregator. `realAccountTested` e fals până când utilizatorul confirmă testul cu un cont real: interfața
 * marchează adaptorul «încă netestat cu cont real», iar trecerea în LIVE e refuzată pe server până atunci.
 */
export interface ShippingCarrier {
  readonly code: ShippingProviderCode;
  readonly label: string;
  quote(request: CarrierQuoteRequest, signal?: AbortSignal): Promise<CarrierQuote[]>;
  createAwb(request: CarrierAwbRequest): Promise<CarrierAwbResult>;
  getLabel(ref: CarrierShipmentRef, format: LabelFormat): Promise<CarrierLabel>;
  track(ref: CarrierShipmentRef): Promise<CarrierTracking>;
  cancel(ref: CarrierShipmentRef): Promise<void>;
  createReturnAwb(
    parent: CarrierShipmentRef,
    request: CarrierAwbRequest,
  ): Promise<CarrierAwbResult>;
  listPickupPoints(filter: {
    countyName: string;
    localityName?: string;
  }): Promise<CarrierPickupPoint[]>;
  /** Apel inofensiv, fără efect asupra comenzilor, cu timp limită. */
  testConnection(): Promise<ConnectionTestResult>;
}

/** Coduri stabile de eroare ale curierilor (în `IntegrationError.code`). */
export const SHIPPING_ERROR_CODES = [
  "SHIPPING_PROVIDER_TIMEOUT",
  "SHIPPING_PROVIDER_UNREACHABLE",
  "SHIPPING_AUTH_FAILED",
  "SHIPPING_REFUSED",
  "SHIPPING_REJECTED",
  "SHIPPING_LOCATION_UNMAPPED",
  "SHIPPING_UNSUPPORTED",
  "SHIPPING_BAD_RESPONSE",
  "SHIPPING_CIRCUIT_OPEN",
] as const;
export type ShippingErrorCode = (typeof SHIPPING_ERROR_CODES)[number];

/** Timp limită al oricărui apel către un curier (cel mult). */
export const SHIPPING_CALL_TIMEOUT_MS = 10_000;
