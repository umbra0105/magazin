import { CartService, OfferService, type OfferSettings } from "@ecom/core";
import { getDb } from "@ecom/db";
import { readCartSettings } from "./cart";
import { getCheckoutService } from "./checkout";
import { getStorage } from "./media";
import { getSettings } from "./services";

/**
 * Oferta de plată pe partea de aplicație (Faza 11): serviciul (un exemplar per proces) și setările citite din baza de date la fiecare
 * cerere. Logica rămâne în `@ecom/core`; coșul temporar al ofertei folosește aceleași reguli ca vitrina.
 */
const globalForOffers = globalThis as unknown as { __ecomOffers?: OfferService };

export async function readOfferSettings(): Promise<OfferSettings> {
  const orders = await getSettings().getGroup("orders");
  return { validityHours: orders.offerValidityHours, numberPrefix: orders.offerNumberPrefix };
}

export function getOfferService(): OfferService {
  globalForOffers.__ecomOffers ??= new OfferService({
    db: getDb(),
    cart: new CartService({ db: getDb(), storage: getStorage(), readSettings: readCartSettings }),
    checkout: getCheckoutService(),
    readSettings: readOfferSettings,
  });
  return globalForOffers.__ecomOffers;
}
