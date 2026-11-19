import type { Parcel, RateOffer } from "./types";

/**
 * Easybox (locker): NU primește produse `oversized` sau `pallet` (nu încap într-un locker, oricât de ieftin ar fi transportul;
 * docs/15 §1). Un singur astfel de produs în coș blochează opțiunea pentru toată comanda. În Faza 9 easybox e o metodă
 * ASCUNSĂ (fără hartă, vine în Faza 12), dar regula există și se testează de pe acum.
 */
export function easyboxAllowed(parcels: readonly Parcel[]): boolean {
  return parcels.every((p) => p.shippingClass === "standard");
}

export interface OfferFilterOptions {
  /** Easybox e o metodă oferită? În Faza 9 nu (fără hartă). */
  easyboxEnabled: boolean;
}

export function filterOffersForParcels(
  offers: readonly RateOffer[],
  parcels: readonly Parcel[],
  options: OfferFilterOptions,
): RateOffer[] {
  const easybox = options.easyboxEnabled && easyboxAllowed(parcels);
  return offers.filter((offer) => offer.kind !== "easybox" || easybox);
}
