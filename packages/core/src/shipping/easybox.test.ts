import { describe, expect, it } from "vitest";
import { easyboxAllowed, filterOffersForParcels } from "./easybox";
import type { Parcel, RateOffer } from "./types";

const parcel = (shippingClass: Parcel["shippingClass"]): Parcel => ({
  variantId: `v-${shippingClass}`,
  sku: "S",
  shippingClass,
  realGrams: 1000,
  volumetricGrams: 0,
  chargeableGrams: 1000,
  volumeCm3: 0,
  wholeUnits: 1,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  incomplete: false,
});

const offer = (kind: RateOffer["kind"], code = kind): RateOffer => ({
  code,
  kind,
  carrier: "Curier",
  service: "S",
  priceMinor: 1000,
  estimatedDays: 2,
  codFeeMinor: 0,
  source: "provider",
  demo: true,
  freeShipping: false,
});

describe("easybox: blocat de produsele oversized sau pallet", () => {
  it("un coș doar cu produse standard permite easybox", () => {
    expect(easyboxAllowed([parcel("standard"), parcel("standard")])).toBe(true);
  });
  it("un singur produs oversized blochează easybox pentru toată comanda", () => {
    expect(easyboxAllowed([parcel("standard"), parcel("oversized")])).toBe(false);
  });
  it("un singur produs pallet blochează easybox pentru toată comanda", () => {
    expect(easyboxAllowed([parcel("standard"), parcel("pallet")])).toBe(false);
  });
  it("oversized și pallet împreună: blocat", () => {
    expect(easyboxAllowed([parcel("oversized"), parcel("pallet")])).toBe(false);
  });
});

describe("filtrarea ofertelor", () => {
  const offers = [offer("courier"), offer("easybox"), offer("pickup")];

  it("easybox dezactivat (Faza 9): oferta dispare mereu, chiar dacă produsele ar permite-o", () => {
    const kinds = filterOffersForParcels(offers, [parcel("standard")], {
      easyboxEnabled: false,
    }).map((o) => o.kind);
    expect(kinds).toEqual(["courier", "pickup"]);
  });
  it("easybox activat: apare doar când coletele o permit", () => {
    const allowed = filterOffersForParcels(offers, [parcel("standard")], { easyboxEnabled: true });
    expect(allowed.map((o) => o.kind)).toEqual(["courier", "easybox", "pickup"]);
    for (const heavy of ["oversized", "pallet"] as const) {
      const blocked = filterOffersForParcels(offers, [parcel("standard"), parcel(heavy)], {
        easyboxEnabled: true,
      });
      expect(
        blocked.map((o) => o.kind),
        heavy,
      ).toEqual(["courier", "pickup"]);
    }
  });
  it("curierul și ridicarea nu sunt atinse de regulă", () => {
    const only = filterOffersForParcels([offer("courier"), offer("pickup")], [parcel("pallet")], {
      easyboxEnabled: true,
    });
    expect(only).toHaveLength(2);
  });
});
