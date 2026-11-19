/**
 * Livrarea (Faza 9): tipurile comune ale furnizorilor de tarife și ale ofertelor. Interfața `ShippingRateProvider` primește
 * LISTA de colete (una pe linie de comandă) ca Faza 12 să poată rafina împachetarea fără să schimbe contractul; regula simplă de
 * azi (un colet logic pe linie, tarifare pe cea mai mare dintre greutatea reală și cea volumetrică) e în `parcels.ts`.
 */

import { SHIPPING_CLASSES, type ShippingClass } from "../catalog/constants";
import type { NormalizedPickupAddress } from "./pickup-address";

export { SHIPPING_CLASSES, type ShippingClass };

export interface Parcel {
  variantId: string;
  sku: string;
  shippingClass: ShippingClass;
  /** Greutatea reală a liniei (greutate pe unitate × cantitate), în grame, rotunjită în sus. */
  realGrams: number;
  /** Greutatea volumetrică a liniei, (L×l×h)/5000, în grame, rotunjită în sus; 0 dacă lipsesc dimensiunile. */
  volumetricGrams: number;
  /** Cea mai mare dintre cele două: pe ea se tarifează. */
  chargeableGrams: number;
  /** Dimensiunile unitare, în mm (informative pentru furnizor); nule dacă lipsesc. */
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Lipsește greutatea sau o dimensiune: tariful poate fi subestimat. */
  incomplete: boolean;
}

export interface RateRequest {
  parcels: readonly Parcel[];
  county: { code: number; name: string };
  locality: { code: number; name: string };
  postalCode: string;
  /** Suma de ramburs (bani) dacă plata e rambursul; 0 altfel. */
  codAmountMinor: number;
}

export type OfferKind = "courier" | "easybox" | "pickup";
export type OfferSource = "provider" | "fallback" | "last_resort" | "pickup";

export interface RateOffer {
  /** Cod stabil al ofertei (curier + serviciu), păstrat în snapshot-ul comenzii. */
  code: string;
  kind: OfferKind;
  carrier: string;
  service: string;
  /** Prețul transportului, cu TVA inclus, în bani (înainte de scutirea de transport gratuit). */
  priceMinor: number;
  estimatedDays: number | null;
  /** Taxa de ramburs a ofertei, în bani, cu TVA inclus; se aplică doar la plata cu ramburs. */
  codFeeMinor: number;
  source: OfferSource;
  /** Valorile vin din tabelul DEMO (nu sunt tarife reale). */
  demo: boolean;
  /** Transportul e gratuit (prag atins): `priceMinor` e deja 0. */
  freeShipping: boolean;
  /** Doar la ridicare personală: adresa MAGAZINULUI (nu a clientului), din `company.address`. */
  pickupAddress?: NormalizedPickupAddress;
}

/** Furnizor de tarife de livrare (agregator, curier). Aruncă sau depășește timpul → serviciul cade pe tarifele pe zonă. */
export interface ShippingRateProvider {
  readonly name: string;
  quote(request: RateRequest, signal: AbortSignal): Promise<RateOffer[]>;
}
