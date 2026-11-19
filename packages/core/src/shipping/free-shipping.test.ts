import { describe, expect, it } from "vitest";
import { applyFreeShipping, freeShippingEligibility } from "./free-shipping";
import type { RateOffer } from "./types";

const line = (
  over: Partial<Parameters<typeof freeShippingEligibility>[0]["lines"][number]> = {},
) => ({
  productId: "p1",
  shippingClass: "standard" as const,
  ...over,
});

const base = {
  thresholdMinor: 50_000,
  enabledClasses: ["standard"] as const,
  excludedProductIds: [] as string[],
  subtotalMinor: 60_000,
  lines: [line()],
};

describe("pragul de transport gratuit: pe clasă și pe produs", () => {
  it("se aplică când pragul e atins și toate liniile sunt eligibile", () => {
    expect(freeShippingEligibility(base)).toEqual({ eligible: true });
  });
  it("exact pragul: gratuit; cu un ban sub el: nu", () => {
    expect(freeShippingEligibility({ ...base, subtotalMinor: 50_000 }).eligible).toBe(true);
    expect(freeShippingEligibility({ ...base, subtotalMinor: 49_999 })).toEqual({
      eligible: false,
      reason: "below_threshold",
    });
  });
  it("fără prag (gol = dezactivat), transportul nu e niciodată gratuit", () => {
    expect(freeShippingEligibility({ ...base, thresholdMinor: null })).toEqual({
      eligible: false,
      reason: "disabled",
    });
  });
  it("o linie oversized sau pallet dezactivează scutirea (implicit clasele nu sunt activate)", () => {
    for (const shippingClass of ["oversized", "pallet"] as const) {
      expect(
        freeShippingEligibility({
          ...base,
          lines: [line(), line({ productId: "p2", shippingClass })],
        }),
      ).toEqual({ eligible: false, reason: "class_excluded" });
    }
  });
  it("dacă adminul activează clasa, scutirea se aplică din nou", () => {
    expect(
      freeShippingEligibility({
        ...base,
        enabledClasses: ["standard", "oversized"],
        lines: [line({ shippingClass: "oversized" })],
      }).eligible,
    ).toBe(true);
  });
  it("un produs exclus dezactivează scutirea pentru toată comanda", () => {
    expect(
      freeShippingEligibility({
        ...base,
        excludedProductIds: ["p2"],
        lines: [line(), line({ productId: "p2" })],
      }),
    ).toEqual({ eligible: false, reason: "product_excluded" });
  });
  it("produsul exclus doar din lista altor produse nu afectează comanda", () => {
    expect(freeShippingEligibility({ ...base, excludedProductIds: ["alt-produs"] }).eligible).toBe(
      true,
    );
  });
  it("coș fără linii fizice: nu există transport de scutit", () => {
    expect(freeShippingEligibility({ ...base, lines: [] }).eligible).toBe(false);
  });
});

describe("applyFreeShipping", () => {
  const offer = (kind: RateOffer["kind"], priceMinor: number): RateOffer => ({
    code: kind,
    kind,
    carrier: "C",
    service: "S",
    priceMinor,
    estimatedDays: 2,
    codFeeMinor: 500,
    source: "provider",
    demo: false,
    freeShipping: false,
  });

  it("pune prețul 0 pe curier și easybox, lasă taxa de ramburs, marchează oferta", () => {
    const result = applyFreeShipping([offer("courier", 2500), offer("easybox", 1800)], true);
    expect(result.map((o) => [o.priceMinor, o.freeShipping, o.codFeeMinor])).toEqual([
      [0, true, 500],
      [0, true, 500],
    ]);
  });
  it("ridicarea rămâne gratuită, fără marcajul de prag", () => {
    expect(applyFreeShipping([offer("pickup", 0)], true)[0]).toMatchObject({
      priceMinor: 0,
      freeShipping: false,
    });
  });
  it("neeligibil: ofertele rămân neatinse", () => {
    const original = [offer("courier", 2500)];
    expect(applyFreeShipping(original, false)).toEqual(original);
  });
});
