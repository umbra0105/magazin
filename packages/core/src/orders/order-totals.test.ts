import { describe, expect, it } from "vitest";
import { computeOrderTotals } from "./order-totals";

const cart = { totalMinor: 1_048_181, vatMinor: 181_915 }; // exemplul din docs/09: TVA pe linii 1.819,15

describe("totalul comenzii: produse + transport + taxă de ramburs, TVA extras din fiecare sumă", () => {
  it("ramburs: transportul și taxa au TVA inclus; TVA total = TVA linii + TVA transport + TVA taxă", () => {
    const totals = computeOrderTotals({
      cart,
      shippingMinor: 2_500,
      codFeeMinor: 500,
      paymentMethod: "cod",
      taxRateBps: 2100,
    });
    // 2500 brut → net round(2500/1,21) = 2066, TVA 434; 500 → net 413, TVA 87
    expect(totals).toEqual({
      subtotalMinor: 1_048_181,
      shippingMinor: 2_500,
      codFeeMinor: 500,
      shippingTaxMinor: 434,
      codFeeTaxMinor: 87,
      taxMinor: 181_915 + 434 + 87,
      totalMinor: 1_048_181 + 2_500 + 500,
    });
  });

  it("transfer bancar: fără taxă de ramburs, chiar dacă oferta are una", () => {
    const totals = computeOrderTotals({
      cart,
      shippingMinor: 2_500,
      codFeeMinor: 500,
      paymentMethod: "bank_transfer",
      taxRateBps: 2100,
    });
    expect(totals.codFeeMinor).toBe(0);
    expect(totals.codFeeTaxMinor).toBe(0);
    expect(totals.totalMinor).toBe(1_048_181 + 2_500);
    expect(totals.taxMinor).toBe(181_915 + 434);
  });

  it("transport gratuit: 0 transport, 0 TVA transport; taxa de ramburs rămâne", () => {
    const totals = computeOrderTotals({
      cart,
      shippingMinor: 0,
      codFeeMinor: 500,
      paymentMethod: "cod",
      taxRateBps: 2100,
    });
    expect(totals.shippingMinor).toBe(0);
    expect(totals.shippingTaxMinor).toBe(0);
    expect(totals.totalMinor).toBe(1_048_181 + 500);
  });

  it("TVA-ul vine din cota dată (nu e hardcodat): altă cotă, alt rezultat", () => {
    const at19 = computeOrderTotals({
      cart: { totalMinor: 10_000, vatMinor: 1_597 },
      shippingMinor: 1_190,
      codFeeMinor: 0,
      paymentMethod: "cod",
      taxRateBps: 1900,
    });
    expect(at19.shippingTaxMinor).toBe(190); // 1190 / 1,19 = 1000 net
    const at21 = computeOrderTotals({
      cart: { totalMinor: 10_000, vatMinor: 1_736 },
      shippingMinor: 1_190,
      codFeeMinor: 0,
      paymentMethod: "cod",
      taxRateBps: 2100,
    });
    expect(at21.shippingTaxMinor).toBe(207); // net round(1190/1,21) = 983, TVA 207
  });

  it("invarianții: total = subtotal + transport + taxă; TVA = linii + transport + taxă; TVA ≤ total", () => {
    for (const shippingMinor of [0, 1, 99, 2_500, 123_457]) {
      for (const codFeeMinor of [0, 1, 500, 1_999]) {
        for (const paymentMethod of ["cod", "bank_transfer"] as const) {
          const t = computeOrderTotals({
            cart,
            shippingMinor,
            codFeeMinor,
            paymentMethod,
            taxRateBps: 2100,
          });
          expect(t.totalMinor).toBe(t.subtotalMinor + t.shippingMinor + t.codFeeMinor);
          expect(t.taxMinor).toBe(cart.vatMinor + t.shippingTaxMinor + t.codFeeTaxMinor);
          expect(t.taxMinor).toBeLessThanOrEqual(t.totalMinor);
          expect(t.shippingTaxMinor).toBeLessThanOrEqual(t.shippingMinor);
          expect(t.codFeeTaxMinor).toBeLessThanOrEqual(t.codFeeMinor);
        }
      }
    }
  });

  it("refuză sume care nu sunt bani întregi nenegativi", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        () =>
          computeOrderTotals({
            cart,
            shippingMinor: bad,
            codFeeMinor: 0,
            paymentMethod: "cod",
            taxRateBps: 2100,
          }),
        String(bad),
      ).toThrow();
      expect(
        () =>
          computeOrderTotals({
            cart,
            shippingMinor: 0,
            codFeeMinor: bad,
            paymentMethod: "cod",
            taxRateBps: 2100,
          }),
        String(bad),
      ).toThrow();
    }
  });
});
