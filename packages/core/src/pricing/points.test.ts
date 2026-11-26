import { describe, expect, it } from "vitest";
import { parseQuantity } from "@ecom/shared";
import { priceLines, type PricingLineInput } from "./engine";
import {
  applyPointsDiscount,
  discountShareForReturn,
  earnedPoints,
  maxRedeemablePoints,
  returnedPoints,
  type RedeemRules,
} from "./points";

/**
 * Regulile punctelor de loialitate în motorul de prețuri (Faza 15b). Toate cifrele sunt calculate de mână, în bani
 * (10000 = 100,00 lei). Implicite: 1 punct = 100 bani (1 leu), minim în bani 100, minim de folosit 10 puncte, fără plafon.
 */
const RULES: RedeemRules = {
  pointValueMinor: 100,
  minCashMinor: 100,
  maxRedeemPercent: null,
  minRedeemPoints: 10,
};

const max = (
  productsMinor: number,
  shippingMinor: number,
  balancePoints = 100_000,
  rules: Partial<RedeemRules> = {},
) =>
  maxRedeemablePoints({
    productsMinor,
    shippingMinor,
    balancePoints,
    rules: { ...RULES, ...rules },
  });

describe("câte puncte se pot folosi (D11)", () => {
  it("produse 100 lei, transport 20 lei, 200 de puncte: 100 de puncte, de plată 20 lei (transportul)", () => {
    // total comandă 12000; în bani cel puțin max(2000, 100) = 2000; min(10000, 12000 − 2000) = 10000 → 100 puncte
    expect(max(10_000, 2_000, 200)).toBe(100);
  });

  it("ridicare personală sau comandă digitală: în bani rămâne cel puțin 1 leu", () => {
    // min(10000, 10000 − 100) = 9900 → 99 puncte
    expect(max(10_000, 0, 200)).toBe(99);
    // 9950 − 100 = 9850 → 98 puncte (restul de 0,50 lei rămâne în bani)
    expect(max(9_950, 0)).toBe(98);
  });

  it("transport mai mic decât minimul în bani: minimul se completează din produse", () => {
    // total 10050; în bani cel puțin max(50, 100) = 100 → 9950 → 99 puncte
    expect(max(10_000, 50)).toBe(99);
    // minim setat la 5 lei, transport 3 lei: 10300 − 500 = 9800 → 98
    expect(max(10_000, 300, 100_000, { minCashMinor: 500 })).toBe(98);
  });

  it("punctele nu ating transportul, oricât de mare ar fi soldul", () => {
    expect(max(10_000, 50_000, 100_000)).toBe(100);
  });

  it("plafonul procentual se aplică pe produse; câștigă cel mai restrictiv", () => {
    // 50% din 10000 = 5000 → 50 puncte
    expect(max(10_000, 2_000, 200, { maxRedeemPercent: 50 })).toBe(50);
    // 100% nu trece peste regula în bani: la ridicare rămân 99
    expect(max(10_000, 0, 200, { maxRedeemPercent: 100 })).toBe(99);
    // 33% din 9999 = 3299,67 → 3299 bani → 32 puncte (în jos)
    expect(max(9_999, 2_000, 200, { maxRedeemPercent: 33 })).toBe(32);
  });

  it("soldul limitează; sub minimul de folosit nu se poate folosi nimic", () => {
    expect(max(10_000, 2_000, 30)).toBe(30);
    expect(max(10_000, 2_000, 10)).toBe(10);
    expect(max(10_000, 2_000, 9)).toBe(0);
    expect(max(10_000, 2_000, 0)).toBe(0);
    expect(max(10_000, 2_000, -5)).toBe(0);
    // comanda permite doar 9 puncte (sub minim) → 0
    expect(max(1_000, 0, 500)).toBe(0);
  });

  it("o comandă de 1 leu fără transport nu primește puncte (nu poate ajunge la 0 lei)", () => {
    expect(max(100, 0, 500, { minRedeemPoints: 1 })).toBe(0);
    expect(max(200, 0, 500, { minRedeemPoints: 1 })).toBe(1);
  });

  it("altă valoare a punctului: 0,50 lei", () => {
    // 10000 − 100 = 9900 → 198 puncte
    expect(max(10_000, 0, 1_000, { pointValueMinor: 50 })).toBe(198);
  });

  it("regula dură ține pe orice combinație: în bani cel puțin max(transport, minim), niciodată 0", () => {
    for (let products = 1; products <= 2_000; products += 37) {
      for (const shipping of [0, 1, 99, 100, 101, 750, 5_000]) {
        for (const pct of [null, 1, 50, 100]) {
          const points = max(products, shipping, 10_000, {
            maxRedeemPercent: pct,
            minRedeemPoints: 1,
          });
          const discount = points * 100;
          expect(discount).toBeLessThanOrEqual(products);
          const cash = products + shipping - discount;
          expect(cash).toBeGreaterThan(0);
          if (points > 0) expect(cash).toBeGreaterThanOrEqual(Math.max(shipping, 100));
        }
      }
    }
  });
});

const line = (key: string, priceMinor: number, quantity = "1"): PricingLineInput => ({
  key,
  productId: `p-${key}`,
  categoryIds: [],
  basis: "unit",
  priceMinor,
  salePriceMinor: null,
  quantity: parseQuantity(quantity, { maxDecimals: 4 }),
  step: parseQuantity("1", { maxDecimals: 4 }),
  taxRateBps: 2100,
  excludeFromGroupDiscount: false,
});

const price = (lines: PricingLineInput[]) =>
  priceLines(lines, {
    applySale: false,
    group: { pricingType: "none" },
    now: new Date(),
    maxLineMinor: 100_000_000,
  });

describe("repartizarea reducerii pe linii (restul cel mai mare, în bani)", () => {
  it("10000 + 3333 + 3333 bani, reducere 1000: 600 + 200 + 200, exact", () => {
    // ponderi/16666: 600,02 / 199,99 / 199,99 → întregi 600+199+199 = 998; cei 2 bani merg la resturile cele mai mari
    const result = applyPointsDiscount(
      price([line("a", 10_000), line("b", 3_333), line("c", 3_333)]),
      1_000,
    );
    expect(result.lines.map((l) => l.pointsDiscountMinor)).toEqual([600, 200, 200]);
    expect(result.totals.pointsDiscountMinor).toBe(1_000);
    expect(result.pointsDiscountMinor).toBe(1_000);
  });

  it("totalul și TVA-ul liniilor rămân cele dinaintea punctelor; reducerea are TVA-ul ei (D14a)", () => {
    const before = price([line("a", 10_000)]);
    const result = applyPointsDiscount(before, 3_333);
    // linia: 100,00 lei cu TVA 17,36; reducerea 33,33 lei cu TVA 5,78 → TVA pe factură 11,58 lei
    expect(result.lines[0]).toMatchObject({
      totalMinor: 10_000,
      vatMinor: 1_736,
      pointsDiscountMinor: 3_333,
      pointsDiscountVatMinor: 578,
    });
    expect(result.totals).toMatchObject({
      totalMinor: 10_000,
      vatMinor: 1_736,
      pointsDiscountMinor: 3_333,
      pointsDiscountVatMinor: 578,
    });
    expect(result.totals.vatMinor - (result.totals.pointsDiscountVatMinor ?? 0)).toBe(1_158);
  });

  it("fiecare parte e între 0 și valoarea liniei, iar suma e exact reducerea", () => {
    const result = applyPointsDiscount(
      price([line("a", 1), line("b", 99), line("c", 12_345, "7")]),
      86_000,
    );
    let sum = 0;
    for (const l of result.lines) {
      const share = l.pointsDiscountMinor ?? -1;
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(l.totalMinor);
      sum += share;
    }
    expect(sum).toBe(86_000);
  });

  it("fără reducere, rezultatul e identic (fără câmpuri noi): paritatea", () => {
    const before = price([line("a", 10_000)]);
    expect(applyPointsDiscount(before, 0)).toEqual(before);
    expect(Object.keys(applyPointsDiscount(before, 0).totals)).toEqual(Object.keys(before.totals));
  });

  it.each([-100, 1.5, 10_001])("reducerea %s e refuzată", (value) => {
    expect(() => applyPointsDiscount(price([line("a", 10_000)]), value)).toThrow();
  });

  it("rezultatul e înghețat", () => {
    expect(Object.isFrozen(applyPointsDiscount(price([line("a", 10_000)]), 100).lines[0])).toBe(
      true,
    );
  });
});

describe("returul: partea de reducere și punctele întoarse (D14b)", () => {
  it("o linie returnată în două bucăți: suma părților e exact reducerea liniei", () => {
    // 3333 × 2500 / 10000 = 833,25 → 833; ultima bucată ia restul: 2500
    const first = discountShareForReturn({
      lineDiscountMinor: 3_333,
      lineGrossMinor: 10_000,
      grossBeforeMinor: 0,
      grossNowMinor: 2_500,
    });
    const rest = discountShareForReturn({
      lineDiscountMinor: 3_333,
      lineGrossMinor: 10_000,
      grossBeforeMinor: 2_500,
      grossNowMinor: 7_500,
    });
    expect([first, rest]).toEqual([833, 2_500]);
  });

  it("banii rămași (brut − partea de reducere) nu sunt niciodată negativi, nici pe linia plătită integral cu puncte", () => {
    for (const discount of [0, 1, 3_333, 9_999, 10_000]) {
      let before = 0;
      let shares = 0;
      for (const now of [1, 33, 34, 99, 4_000, 5_833]) {
        const share = discountShareForReturn({
          lineDiscountMinor: discount,
          lineGrossMinor: 10_000,
          grossBeforeMinor: before,
          grossNowMinor: now,
        });
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(now);
        shares += share;
        before += now;
      }
      expect(before).toBe(10_000);
      expect(shares).toBe(discount);
    }
  });

  it("nu se returnează peste valoarea liniei", () => {
    expect(() =>
      discountShareForReturn({
        lineDiscountMinor: 1,
        lineGrossMinor: 100,
        grossBeforeMinor: 90,
        grossNowMinor: 11,
      }),
    ).toThrow();
  });

  it("punctele întoarse: în jos pe totalul returnat până atunci; la retur integral, toate", () => {
    // 100 de puncte (10000 bani) pe trei linii de 3333 / 3333 / 3334
    const of = (returnedDiscountMinor: number) =>
      returnedPoints({
        returnedDiscountMinor,
        totalDiscountMinor: 10_000,
        pointValueMinor: 100,
        pointsUsed: 100,
      });
    expect([of(0), of(3_333), of(6_666), of(10_000)]).toEqual([0, 33, 66, 100]);
  });

  it("niciodată mai multe puncte decât cele folosite", () => {
    expect(
      returnedPoints({
        returnedDiscountMinor: 10_000,
        totalDiscountMinor: 10_000,
        pointValueMinor: 1,
        pointsUsed: 100,
      }),
    ).toBe(100);
  });
});

describe("acumularea: floor, pe banii plătiți", () => {
  it.each([
    [19_900, 1],
    [100_000, 10],
    [9_999, 0],
    [10_000, 1],
    [0, 0],
    [-500, 0],
  ])("%i bani → %i puncte (1 punct la 100 lei)", (base, points) => {
    expect(earnedPoints(base, 10_000)).toBe(points);
  });

  it("rata trebuie să fie pozitivă", () => {
    expect(() => earnedPoints(100, 0)).toThrow();
  });
});
