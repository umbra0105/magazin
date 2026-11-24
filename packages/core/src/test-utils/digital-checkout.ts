import { randomUUID } from "node:crypto";
import type { CartOwner } from "../cart/cart-service";
import { DIGITAL_CONSENT_DEFAULT_VERSION } from "../digital/digital-rules";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { q, type Harness } from "./checkout-fixtures";
import { createUser } from "./digital-fixtures";

/**
 * Ajutoare comune pentru testele de checkout cu produse digitale (Faza 14c): un cumpărător cu cont, un produs digital, coșul lui și
 * intrările de plasare (100% digital, mixt). Nu presupun seed: totul se creează în tranzacția anulată a harness-ului.
 */
export const DEMO_CARD = { code: "demo", mode: "demo" } as const;

export interface World {
  h: Harness;
  userId: string;
  owner: CartOwner;
}

export async function userWorld(h: Harness, verified = true): Promise<World> {
  const user = await createUser(h.tx, verified);
  return { h, userId: user.id, owner: { kind: "user", userId: user.id } };
}

export async function addTo(world: World, items: Array<{ variantId: string; quantity?: string }>) {
  for (const item of items) {
    await world.h.cart.add(world.owner, {
      variantId: item.variantId,
      quantity: item.quantity ? q(item.quantity) : "minimum",
    });
  }
}

export const digitalProduct = (h: Harness, price = 30_000) =>
  h.product({ type: "digital", manageStock: false, price });

export const billingAddress = (h: Harness) => ({
  fullName: "Ion Popescu",
  phone: "0722123456",
  countyCode: h.geo.countyCode,
  localityCode: h.geo.localityCode,
  street: "Str. Facturii 1",
  postalCode: "123456",
});

export const destination = (h: Harness) => ({
  countyCode: h.geo.countyCode,
  localityCode: h.geo.localityCode,
  postalCode: "123456",
});

/** Intrarea unei comenzi 100% digitale: fără adresă și ofertă de livrare, cu adresa de facturare proprie și bifa legală. */
export async function digitalOnlyInput(world: World, over: Record<string, unknown> = {}) {
  const { h, owner } = world;
  const method = (over["paymentMethod"] as "cod" | "bank_transfer" | "card" | undefined) ?? "card";
  const preview = await h.checkout.preview({ owner, destination: null, paymentMethod: method });
  return {
    idempotencyKey: randomUUID(),
    contact: { email: "client@exemplu.ro", phone: "0722 123 456" },
    billing: { sameAsShipping: false, address: billingAddress(h) },
    company: null,
    paymentMethod: method,
    consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
    digitalConsent: { accepted: true, version: DIGITAL_CONSENT_DEFAULT_VERSION },
    expectedTotalMinor: preview.totals?.totalMinor ?? 1,
    ...over,
  };
}

/** Intrarea unei comenzi MIXTE: ca la o comandă fizică (adresă și ofertă de livrare), plus bifa legală. */
export async function mixedInput(world: World, over: Record<string, unknown> = {}) {
  return world.h.input(world.owner, {
    digitalConsent: { accepted: true, version: DIGITAL_CONSENT_DEFAULT_VERSION },
    ...over,
  });
}
