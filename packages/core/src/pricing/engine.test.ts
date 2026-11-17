import { describe, expect, it } from "vitest";
import {
  MoneyError,
  QuantityError,
  netFromGross,
  parseQuantity,
  quantityFromTicks,
  stepsToQuantity,
  vatFromGross,
  type Quantity,
} from "@ecom/shared";
import {
  activeSalePrice,
  excludedFromGroupPricing,
  resolveUnitPrice,
  priceLines,
  type PriceGroup,
  type PricingCoupon,
  type PricingLineInput,
  type PricingOptions,
} from "./engine";

/** Ceasul se INJECTEAZĂ (docs: fără date fixe comparate cu ceasul real); toate datele testului pleacă din acest NOW. */
const NOW = new Date("2026-06-01T10:00:00.000Z");
const DAY = 86_400_000;
const MAX = 1_000_000_000;

const qty = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });
const ONE = quantityFromTicks(10_000n);

const none: PriceGroup = { pricingType: "none" };
const discount = (bps: number, stacks = false): PriceGroup => ({
  pricingType: "discount",
  discountBps: bps,
  stacksWithSalePrice: stacks,
});
const costPlus = (bps: number): PriceGroup => ({ pricingType: "cost_plus", markupBps: bps });

function line(overrides: Partial<PricingLineInput> = {}): PricingLineInput {
  return {
    key: "v1",
    productId: "p1",
    categoryIds: ["c1"],
    basis: "unit",
    priceMinor: 19900,
    salePriceMinor: null,
    quantity: ONE,
    step: ONE,
    taxRateBps: 2100,
    excludeFromGroupDiscount: false,
    costNetMinor: null,
    ...overrides,
  };
}

function options(overrides: Partial<PricingOptions> = {}): PricingOptions {
  return { applySale: true, group: none, coupon: null, now: NOW, maxLineMinor: MAX, ...overrides };
}

function total(lines: PricingLineInput[], opts: Partial<PricingOptions> = {}) {
  return priceLines(lines, options(opts));
}

const coupon = (overrides: Partial<PricingCoupon> = {}): PricingCoupon => ({
  code: "TEST10",
  discount: { type: "percent", bps: 1000 },
  notForDiscountedGroups: false,
  excludedProductIds: [],
  excludedCategoryIds: [],
  minSubtotalMinor: null,
  startsAt: null,
  endsAt: null,
  ...overrides,
});

describe("Motor de prețuri: prețul public și extragerea TVA", () => {
  it("o linie la preț public: totalul e prețul brut, TVA-ul se EXTRAGE din brut", () => {
    const result = total([line()]);
    const [l] = result.lines;
    expect(l?.totalMinor).toBe(19900);
    expect(l?.netMinor).toBe(16446);
    expect(l?.vatMinor).toBe(3454);
    expect(l?.netMinor).toBe(netFromGross(19900, 2100));
    expect(l?.vatMinor).toBe(vatFromGross(19900, 2100));
    expect(result.totals.totalMinor).toBe(19900);
    expect(result.coupon).toBeNull();
  });

  it("3 cutii × 2,03 mp = 6,09 mp", () => {
    const quantity = stepsToQuantity(3, qty("2,03"));
    expect(quantity).toBe(qty("6,09"));
    const result = total([line({ priceMinor: 12345, quantity, step: qty("2,03") })]);
    expect(result.lines[0]?.totalMinor).toBe(75181);
  });

  it("exemplul din INTREBARI-CONTABIL întrebarea 4: 6,09 mp × 123,45 = 751,81, nu 751,80", () => {
    const result = total([line({ priceMinor: 12345, quantity: qty("6,09"), step: qty("2,03") })]);
    expect(result.lines[0]?.totalMinor).toBe(75181);
    expect(result.lines[0]?.totalMinor).not.toBe(75180);
    // net 621,33 + TVA 130,48 (din exemplu)
    expect(result.lines[0]?.netMinor).toBe(62133);
    expect(result.lines[0]?.vatMinor).toBe(13048);
  });

  it("liner 41,25 mp: 2 role = 82,5 mp × 87,35 lei/mp = 7.206,38 lei (R1)", () => {
    const step = qty("41,25");
    const result = total([line({ priceMinor: 8735, quantity: stepsToQuantity(2, step), step })]);
    expect(result.lines[0]?.totalMinor).toBe(720638);
  });

  it("bisulfat pe pas (R2): 2 saci × 120,00 lei = 240,00 lei, 4,80 lei/kg informativ", () => {
    const step = qty("25");
    const result = total([
      line({ basis: "step", priceMinor: 12000, quantity: stepsToQuantity(2, step), step }),
    ]);
    expect(result.lines[0]?.totalMinor).toBe(24000);
    expect(result.lines[0]?.unitPriceMinor).toBe(12000); // prețul pe baza liniei (pasul)
  });

  it("țeavă la ml pe pași de 2,5: 3 pași = 7,5 ml", () => {
    const step = qty("2,5");
    const result = total([line({ priceMinor: 3333, quantity: stepsToQuantity(3, step), step })]);
    expect(result.lines[0]?.totalMinor).toBe(24998);
  });

  it("baza «pe pas» cere o cantitate multiplu EXACT al pasului", () => {
    expect(() =>
      total([line({ basis: "step", priceMinor: 12000, quantity: qty("30"), step: qty("25") })]),
    ).toThrow(QuantityError);
  });

  it("depășirea plafonului liniei (MAX_MONEY) se REFUZĂ, nu se taie", () => {
    expect(() => total([line({ priceMinor: MAX, quantity: qty("2") })])).toThrow(MoneyError);
    expect(() =>
      total([line({ basis: "step", priceMinor: MAX, quantity: qty("2"), step: ONE })]),
    ).toThrow(MoneyError);
    // la plafon exact, merge
    expect(total([line({ priceMinor: MAX })]).lines[0]?.totalMinor).toBe(MAX);
  });

  it("cota de TVA vine din intrare, nu e hardcodată: 21% și o a doua cotă (9%)", () => {
    const standard = total([line({ taxRateBps: 2100 })]).lines[0];
    const reduced = total([line({ taxRateBps: 900 })]).lines[0];
    expect(standard?.vatMinor).toBe(3454);
    expect(reduced?.vatMinor).toBe(vatFromGross(19900, 900));
    expect(reduced?.vatMinor).toBe(1643);
    expect(reduced?.netMinor).toBe(18257);
    expect(reduced?.taxRateBps).toBe(900);
    // totalul brut nu depinde de cotă
    expect(reduced?.totalMinor).toBe(standard?.totalMinor);
  });

  it("totalul coșului = suma liniilor rotunjite o singură dată (și TVA-ul = suma TVA-urilor pe linie)", () => {
    const lines = [
      line({ key: "a", priceMinor: 12345, quantity: qty("3") }),
      line({ key: "b", priceMinor: 8735, quantity: qty("6,09"), step: qty("2,03") }),
      line({ key: "c", priceMinor: 999, quantity: qty("3") }),
    ];
    const result = total(lines);
    const sum = result.lines.reduce((acc, l) => acc + l.totalMinor, 0);
    expect(result.totals.totalMinor).toBe(sum);
    expect(result.totals.netMinor).toBe(result.lines.reduce((acc, l) => acc + l.netMinor, 0));
    expect(result.totals.vatMinor).toBe(result.lines.reduce((acc, l) => acc + l.vatMinor, 0));
    expect(result.totals.netMinor + result.totals.vatMinor).toBe(result.totals.totalMinor);
    for (const l of result.lines) expect(l.netMinor + l.vatMinor).toBe(l.totalMinor);
  });

  it("rezultatul e date simple (fără bigint), înghețat: o recalculare nu schimbă rezultatul vechi", () => {
    const before = total([line({ taxRateBps: 2100 })]);
    const snapshot = JSON.stringify(before);
    expect(() => JSON.parse(snapshot)).not.toThrow();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.lines[0])).toBe(true);
    // altă cotă și alt preț: un rezultat NOU; cel vechi rămâne neschimbat
    const after = total([line({ taxRateBps: 900, priceMinor: 25000 })]);
    expect(after.lines[0]?.totalMinor).toBe(25000);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("coș gol: totaluri zero", () => {
    const result = total([]);
    expect(result.lines).toEqual([]);
    expect(result.totals.totalMinor).toBe(0);
    expect(result.pointsDiscountMinor).toBe(0);
  });
});

describe("Motor de prețuri: promoția (salePrice), în ambele moduri", () => {
  it("applySale = true: prețul promoțional activ înlocuiește prețul de listă", () => {
    const result = total([line({ salePriceMinor: 15000 })], { applySale: true });
    expect(result.lines[0]?.totalMinor).toBe(15000);
    expect(result.lines[0]?.priceSource).toBe("sale");
  });

  it("applySale = false (vitrina nu arată reduceri): se percepe prețul întreg, promoția e ignorată", () => {
    const result = total([line({ salePriceMinor: 15000 })], { applySale: false });
    expect(result.lines[0]?.totalMinor).toBe(19900);
    expect(result.lines[0]?.priceSource).toBe("public");
  });

  it("o promoție care nu scade prețul (≥ listă) nu schimbă nimic", () => {
    expect(total([line({ salePriceMinor: 19900 })]).lines[0]?.totalMinor).toBe(19900);
    expect(total([line({ salePriceMinor: 25000 })]).lines[0]?.totalMinor).toBe(19900);
  });

  it("promoția se aplică pe baza liniei (pe unitate și pe pas)", () => {
    const step = qty("25");
    const result = total([
      line({
        basis: "step",
        priceMinor: 12000,
        salePriceMinor: 10000,
        quantity: stepsToQuantity(2, step),
        step,
      }),
    ]);
    expect(result.lines[0]?.totalMinor).toBe(20000);
  });
});

describe("Motor de prețuri: grupul «discount» (Fidel 5%, VIP 7%)", () => {
  it("fără promoție: preț − 5% = 189,05", () => {
    const l = total([line()], { group: discount(500) }).lines[0];
    expect(l?.totalMinor).toBe(18905);
    expect(l?.priceSource).toBe("group_discount");
    expect(l?.groupAdvantageMinor).toBe(995); // diferența față de prețul public, informativ
  });

  it("VIP 7%: 199,00 − 7% = 185,07", () => {
    expect(total([line()], { group: discount(700) }).lines[0]?.totalMinor).toBe(18507);
  });

  it("cu promoție, NECUMULAT (implicit): se ia cel mai mic dintre prețul de grup și promoție", () => {
    // promoție 150,00 < 189,05 → promoția
    const lowerSale = total([line({ salePriceMinor: 15000 })], { group: discount(500) }).lines[0];
    expect(lowerSale?.totalMinor).toBe(15000);
    expect(lowerSale?.priceSource).toBe("sale");
    // promoție 195,00 > 189,05 → prețul de grup
    const higherSale = total([line({ salePriceMinor: 19500 })], { group: discount(500) }).lines[0];
    expect(higherSale?.totalMinor).toBe(18905);
    expect(higherSale?.priceSource).toBe("group_discount");
  });

  it("cu promoție, CUMULAT (stacksWithSalePrice): promoția − 5% = 142,50", () => {
    const l = total([line({ salePriceMinor: 15000 })], { group: discount(500, true) }).lines[0];
    expect(l?.totalMinor).toBe(14250);
    expect(l?.priceSource).toBe("group_discount");
  });

  it("stacksWithSalePrice fără promoție activă: preț − 5%", () => {
    expect(total([line()], { group: discount(500, true) }).lines[0]?.totalMinor).toBe(18905);
  });

  it("applySale = false: promoția nu există, deci nici cumulul (preț − 5%)", () => {
    const l = total([line({ salePriceMinor: 15000 })], {
      group: discount(500, true),
      applySale: false,
    }).lines[0];
    expect(l?.totalMinor).toBe(18905);
  });

  it("rotunjire pe linie, o singură dată: 7 × (preț − 5%) are fracțiune de ban", () => {
    // 12345 × 0,95 = 11727,75 per unitate; × 7 = 82094,25 → 82094 (nu 7 × 11728 = 82096)
    const l = total([line({ priceMinor: 12345, quantity: qty("7") })], { group: discount(500) })
      .lines[0];
    expect(l?.totalMinor).toBe(82094);
  });

  it("produs sau categorie cu excludeFromGroupDiscount: toți plătesc prețul public", () => {
    const l = total([line({ excludeFromGroupDiscount: true })], { group: discount(500) }).lines[0];
    expect(l?.totalMinor).toBe(19900);
    expect(l?.priceSource).toBe("public");
    expect(l?.groupAdvantageMinor).toBe(0);
  });

  it("excluderea vine de la produs SAU de la oricare dintre categoriile lui", () => {
    expect(excludedFromGroupPricing(false, [false, false])).toBe(false);
    expect(excludedFromGroupPricing(true, [false])).toBe(true);
    expect(excludedFromGroupPricing(false, [false, true])).toBe(true);
    expect(excludedFromGroupPricing(false, [])).toBe(false);
  });
});

describe("Motor de prețuri: grupul «cost_plus» (Partener 1/2/3)", () => {
  it("formula: cost net 100,00 · adaos 12% · TVA 21% = 135,52", () => {
    const l = total([line({ priceMinor: 20000, costNetMinor: 10000 })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(13552);
    expect(l?.priceSource).toBe("group_cost_plus");
    expect(l?.groupAdvantageMinor).toBe(6448);
  });

  it("PLAFON: prețul calculat > prețul public → se plătește prețul public", () => {
    const l = total([line({ priceMinor: 12000, costNetMinor: 10000 })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(12000);
    expect(l?.priceSource).toBe("public");
  });

  it("PLAFON: prețul calculat < prețul public → se plătește cel calculat", () => {
    expect(
      total([line({ priceMinor: 20000, costNetMinor: 10000 })], { group: costPlus(1200) }).lines[0]
        ?.totalMinor,
    ).toBe(13552);
  });

  it("PLAFON față de prețul PROMOȚIONAL: promoția scade sub prețul de partener", () => {
    const l = total([line({ priceMinor: 20000, salePriceMinor: 12900, costNetMinor: 10000 })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(12900); // 129,00 < 135,52
    expect(l?.priceSource).toBe("sale");
  });

  it("applySale = false: promoția nu plafonează, plafonul e prețul întreg", () => {
    const l = total([line({ priceMinor: 20000, salePriceMinor: 12900, costNetMinor: 10000 })], {
      group: costPlus(1200),
      applySale: false,
    }).lines[0];
    expect(l?.totalMinor).toBe(13552);
  });

  it("produs fără preț de achiziție → prețul public", () => {
    const l = total([line({ priceMinor: 20000, costNetMinor: null })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(20000);
    expect(l?.priceSource).toBe("public");
  });

  it("produs/categorie exclus: prețul public pentru Partener", () => {
    const l = total(
      [line({ priceMinor: 20000, costNetMinor: 10000, excludeFromGroupDiscount: true })],
      { group: costPlus(1200) },
    ).lines[0];
    expect(l?.totalMinor).toBe(20000);
  });

  it("rotunjire pe linie la cost_plus: cantitate 7 cu fracțiune de ban, rotunjit o singură dată", () => {
    // 100,01 × 1,12 × 1,21 = 135,533552 lei/unitate; × 7 = 948,734864 lei → 948,73
    const l = total([line({ priceMinor: 50000, costNetMinor: 10001, quantity: qty("7") })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(94873);
    expect(l?.totalMinor).not.toBe(7 * 13553); // 94871: prețul unitar rotunjit întâi ar fi greșit
  });

  it("TVA-ul de pe cost_plus e cota produsului, din intrare (a doua cotă de test)", () => {
    // 100,00 × 1,12 × 1,09 = 122,08
    const l = total([line({ priceMinor: 20000, costNetMinor: 10000, taxRateBps: 900 })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(12208);
    expect(l?.taxRateBps).toBe(900);
  });

  it("cost_plus pe baza «pe pas»: costul e pe pas", () => {
    const step = qty("25");
    const l = total(
      [
        line({
          basis: "step",
          priceMinor: 20000,
          costNetMinor: 10000,
          quantity: stepsToQuantity(2, step),
          step,
        }),
      ],
      { group: costPlus(1200) },
    ).lines[0];
    expect(l?.totalMinor).toBe(27104); // 2 × 135,52
  });

  it("stacksWithSalePrice nu are sens la cost_plus (se ia oricum minimul)", () => {
    // nu există la cost_plus: forma tipului nu o permite; minimul decide
    const l = total([line({ priceMinor: 20000, salePriceMinor: 15000, costNetMinor: 10000 })], {
      group: costPlus(1200),
    }).lines[0];
    expect(l?.totalMinor).toBe(13552);
  });
});

describe("Motor de prețuri: cuponul", () => {
  it("procentual, peste prețul de grup (cumul): 199,00 − 5% = 189,05, apoi −10% = 170,145 → 170,15", () => {
    const result = total([line()], { group: discount(500), coupon: coupon() });
    expect(result.lines[0]?.totalMinor).toBe(17015);
    expect(result.lines[0]?.couponMinor).toBe(1890);
    expect(result.coupon).toMatchObject({ status: "applied", code: "TEST10", discountMinor: 1890 });
    expect(result.totals.couponMinor).toBe(1890);
  });

  it("procentual fără grup: 199,00 − 10% = 179,10", () => {
    expect(total([line()], { coupon: coupon() }).lines[0]?.totalMinor).toBe(17910);
  });

  it("cuponul se rotunjește o singură dată pe linie, pe valoarea exactă (nu peste una deja rotunjită)", () => {
    // 12345 × 0,95 × 0,9 × 7 = 73884,… exact: 12345×7=86415; ×0,95=82094,25; ×0,9=73884,825 → 73885
    const l = total([line({ priceMinor: 12345, quantity: qty("7") })], {
      group: discount(500),
      coupon: coupon(),
    }).lines[0];
    expect(l?.totalMinor).toBe(73885);
  });

  it("notForDiscountedGroups: blocat pentru ORICE grup cu pricingType ≠ none", () => {
    const blocking = coupon({ notForDiscountedGroups: true });
    for (const group of [discount(500), discount(700, true), costPlus(1200)]) {
      const result = total([line({ costNetMinor: 10000 })], { group, coupon: blocking });
      expect(result.coupon).toMatchObject({ status: "rejected", reason: "blocked_for_group" });
      expect(result.totals.couponMinor).toBe(0);
    }
  });

  it("notForDiscountedGroups: se aplică clientului standard (none)", () => {
    const result = total([line()], { coupon: coupon({ notForDiscountedGroups: true }) });
    expect(result.coupon).toMatchObject({ status: "applied" });
    expect(result.lines[0]?.totalMinor).toBe(17910);
  });

  it("blocarea de grup se aplică chiar dacă produsul e exclus din prețul de grup", () => {
    const result = total([line({ excludeFromGroupDiscount: true })], {
      group: discount(500),
      coupon: coupon({ notForDiscountedGroups: true }),
    });
    expect(result.coupon).toMatchObject({ status: "rejected", reason: "blocked_for_group" });
  });

  it("produse și categorii excluse din cupon: reducerea cade doar pe liniile eligibile", () => {
    const lines = [
      line({ key: "a", productId: "pa", categoryIds: ["c1"], priceMinor: 10000 }),
      line({ key: "b", productId: "pb", categoryIds: ["c2"], priceMinor: 10000 }),
      line({ key: "c", productId: "pc", categoryIds: ["c3"], priceMinor: 10000 }),
    ];
    const result = total(lines, {
      coupon: coupon({ excludedProductIds: ["pb"], excludedCategoryIds: ["c3"] }),
    });
    expect(result.lines.map((l) => l.totalMinor)).toEqual([9000, 10000, 10000]);
    expect(result.lines.map((l) => l.couponMinor)).toEqual([1000, 0, 0]);
    expect(result.coupon).toMatchObject({ status: "applied", discountMinor: 1000 });
  });

  it("toate liniile excluse → cupon respins (nimic de redus)", () => {
    const result = total([line({ productId: "pb" })], {
      coupon: coupon({ excludedProductIds: ["pb"] }),
    });
    expect(result.coupon).toMatchObject({ status: "rejected", reason: "no_eligible_lines" });
  });

  it("valoare minimă: sub minim → respins; la minim exact → aplicat (subtotalul de după prețul de grup)", () => {
    const lines = [line({ priceMinor: 10000 })];
    const rejected = total(lines, { coupon: coupon({ minSubtotalMinor: 10001 }) });
    expect(rejected.coupon).toMatchObject({ status: "rejected", reason: "min_subtotal" });
    expect(rejected.lines[0]?.totalMinor).toBe(10000);
    const accepted = total(lines, { coupon: coupon({ minSubtotalMinor: 10000 }) });
    expect(accepted.coupon).toMatchObject({ status: "applied" });
    // minimul se judecă pe subtotalul de după prețul de grup, nu pe cel public
    const afterGroup = total(lines, {
      group: discount(500),
      coupon: coupon({ minSubtotalMinor: 10000 }),
    });
    expect(afterGroup.coupon).toMatchObject({ status: "rejected", reason: "min_subtotal" });
  });

  it("valabilitate: încă nu a început → respins; expirat → respins; în interval → aplicat (final exclusiv)", () => {
    const lines = [line()];
    const future = total(lines, { coupon: coupon({ startsAt: new Date(NOW.getTime() + DAY) }) });
    expect(future.coupon).toMatchObject({ status: "rejected", reason: "not_started" });
    const expired = total(lines, { coupon: coupon({ endsAt: new Date(NOW.getTime() - DAY) }) });
    expect(expired.coupon).toMatchObject({ status: "rejected", reason: "expired" });
    const endsNow = total(lines, { coupon: coupon({ endsAt: NOW }) });
    expect(endsNow.coupon).toMatchObject({ status: "rejected", reason: "expired" });
    const startsNow = total(lines, {
      coupon: coupon({ startsAt: NOW, endsAt: new Date(NOW.getTime() + DAY) }),
    });
    expect(startsNow.coupon).toMatchObject({ status: "applied" });
  });

  it("sumă fixă: se repartizează pe liniile eligibile, suma reducerilor = valoarea cuponului", () => {
    const lines = [
      line({ key: "a", priceMinor: 10000 }),
      line({ key: "b", priceMinor: 20000 }),
      line({ key: "c", priceMinor: 5000 }),
    ];
    const result = total(lines, {
      coupon: coupon({ discount: { type: "fixed", amountMinor: 3333 } }),
    });
    const parts = result.lines.map((l) => l.couponMinor);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(3333);
    expect(result.coupon).toMatchObject({ status: "applied", discountMinor: 3333 });
    expect(result.totals.totalMinor).toBe(35000 - 3333);
    result.lines.forEach((l, i) => {
      expect(l.totalMinor).toBe((lines[i]?.priceMinor ?? 0) - l.couponMinor);
    });
  });

  it("sumă fixă: PLAFON la valoarea liniilor eligibile (nicio linie sub zero)", () => {
    const lines = [line({ key: "a", priceMinor: 1000 }), line({ key: "b", priceMinor: 2000 })];
    const result = total(lines, {
      coupon: coupon({ discount: { type: "fixed", amountMinor: 999_999 } }),
    });
    expect(result.lines.map((l) => l.totalMinor)).toEqual([0, 0]);
    expect(result.coupon).toMatchObject({ status: "applied", discountMinor: 3000 });
  });

  it("sumă fixă pe linii excluse: reducerea nu trece de valoarea liniilor eligibile", () => {
    const lines = [
      line({ key: "a", productId: "pa", priceMinor: 4000 }),
      line({ key: "b", productId: "pb", priceMinor: 50000 }),
    ];
    const result = total(lines, {
      coupon: coupon({
        discount: { type: "fixed", amountMinor: 10000 },
        excludedProductIds: ["pb"],
      }),
    });
    expect(result.lines.map((l) => l.totalMinor)).toEqual([0, 50000]);
    expect(result.coupon).toMatchObject({ discountMinor: 4000 });
  });

  it("cuponul se cumulează cu promoția (applySale = true)", () => {
    const l = total([line({ salePriceMinor: 15000 })], { coupon: coupon() }).lines[0];
    expect(l?.totalMinor).toBe(13500);
  });

  it("cuponul nu poate depăși 100% și nu poate fi negativ (intrări invalide se refuză)", () => {
    expect(() =>
      total([line()], { coupon: coupon({ discount: { type: "percent", bps: 10001 } }) }),
    ).toThrow();
    expect(() =>
      total([line()], { coupon: coupon({ discount: { type: "percent", bps: 0 } }) }),
    ).toThrow();
    expect(() =>
      total([line()], { coupon: coupon({ discount: { type: "fixed", amountMinor: 0 } }) }),
    ).toThrow();
    expect(() =>
      total([line()], { coupon: coupon({ discount: { type: "fixed", amountMinor: -5 } }) }),
    ).toThrow();
  });

  it("puncte de loialitate: pasul există, dar în Faza 8 valoarea e zero", () => {
    const result = total([line()], { coupon: coupon() });
    expect(result.pointsDiscountMinor).toBe(0);
  });
});

describe("Motor de prețuri: proprietăți (generator determinist, fără ceas și fără float)", () => {
  let state = 987654321n;
  const next = (modulo: bigint): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return (state >> 16n) % modulo;
  };
  const pick = <T>(items: readonly T[]): T => items[Number(next(BigInt(items.length)))] as T;

  const randomLine = (key: string): PricingLineInput => {
    const priceMinor = Number(next(2_000_000n)) + 1;
    const salePrice = next(2n) === 0n ? null : Number(next(BigInt(priceMinor) + 500n)) + 1;
    return line({
      key,
      priceMinor,
      salePriceMinor: salePrice,
      quantity: quantityFromTicks(next(900_000n) + 1n),
      taxRateBps: pick([0, 500, 900, 1900, 2100]),
      costNetMinor: next(3n) === 0n ? null : Number(next(1_500_000n)) + 1,
      excludeFromGroupDiscount: next(5n) === 0n,
    });
  };

  const groups: PriceGroup[] = [
    none,
    discount(500),
    discount(700, true),
    costPlus(1200),
    costPlus(2100),
  ];

  it("totalul = suma liniilor; net + TVA = brut pe fiecare linie, pe orice coș, grup și cupon", () => {
    for (let i = 0; i < 250; i++) {
      const lines = Array.from({ length: 1 + Number(next(5n)) }, (_, n) => randomLine(`l${n}`));
      const result = total(lines, {
        group: pick(groups),
        applySale: next(2n) === 0n,
        coupon:
          next(2n) === 0n
            ? coupon({ discount: { type: "percent", bps: Number(next(9999n)) + 1 } })
            : next(2n) === 0n
              ? coupon({ discount: { type: "fixed", amountMinor: Number(next(500_000n)) + 1 } })
              : null,
      });
      expect(result.totals.totalMinor).toBe(result.lines.reduce((a, l) => a + l.totalMinor, 0));
      for (const l of result.lines) {
        expect(Number.isSafeInteger(l.totalMinor)).toBe(true);
        expect(l.totalMinor).toBeGreaterThanOrEqual(0);
        expect(l.netMinor + l.vatMinor).toBe(l.totalMinor);
        expect(l.totalMinor + l.couponMinor).toBe(l.afterGroupMinor);
      }
    }
  });

  it("un client de grup nu plătește NICIODATĂ mai mult decât prețul public curent al liniei", () => {
    for (let i = 0; i < 250; i++) {
      const input = randomLine("x");
      const applySale = next(2n) === 0n;
      const publicLine = total([input], { group: none, applySale }).lines[0];
      const grouped = total([input], { group: pick(groups), applySale }).lines[0];
      expect((grouped?.totalMinor ?? 0) <= (publicLine?.totalMinor ?? 0)).toBe(true);
    }
  });

  it("monotonie: o cantitate mai mare nu scade valoarea liniei", () => {
    for (let i = 0; i < 250; i++) {
      const base = randomLine("m");
      const a = quantityFromTicks(next(500_000n) + 1n);
      const b = quantityFromTicks(BigInt(a) + next(500_000n));
      const group = pick(groups);
      const lineA = total([{ ...base, quantity: a }], { group }).lines[0];
      const lineB = total([{ ...base, quantity: b }], { group }).lines[0];
      expect((lineB?.totalMinor ?? 0) >= (lineA?.totalMinor ?? 0)).toBe(true);
    }
  });

  it("promoția nu scumpește: cu applySale prețul e ≤ cel fără promoție", () => {
    for (let i = 0; i < 250; i++) {
      const input = randomLine("s");
      const withSale = total([input], { applySale: true }).lines[0];
      const withoutSale = total([input], { applySale: false }).lines[0];
      expect((withSale?.totalMinor ?? 0) <= (withoutSale?.totalMinor ?? 0)).toBe(true);
    }
  });
});

describe("Motor de prețuri: prețul unitar fără cantitate și fereastra promoției", () => {
  it("resolveUnitPrice dă același preț ca priceLines (un singur calcul de preț)", () => {
    const input = line({ salePriceMinor: 15000 });
    expect(resolveUnitPrice(input, { applySale: true, group: none })).toEqual({
      unitPriceMinor: 15000,
      priceSource: "sale",
    });
    expect(resolveUnitPrice(input, { applySale: false, group: none })).toEqual({
      unitPriceMinor: 19900,
      priceSource: "public",
    });
    const priced = total([line({ salePriceMinor: 15000 })], { group: discount(500, true) });
    expect(
      resolveUnitPrice(input, { applySale: true, group: discount(500, true) }).unitPriceMinor,
    ).toBe(priced.lines[0]?.unitPriceMinor);
  });

  it("promoția activă: început inclusiv, sfârșit exclusiv, fără promoție → null", () => {
    const base = { salePrice: 15000, saleStartsAt: null, saleEndsAt: null };
    expect(activeSalePrice(base, NOW)).toBe(15000);
    expect(activeSalePrice({ ...base, salePrice: null }, NOW)).toBeNull();
    expect(activeSalePrice({ ...base, saleStartsAt: NOW }, NOW)).toBe(15000);
    expect(activeSalePrice({ ...base, saleStartsAt: new Date(NOW.getTime() + 1) }, NOW)).toBeNull();
    expect(activeSalePrice({ ...base, saleEndsAt: NOW }, NOW)).toBeNull();
    expect(activeSalePrice({ ...base, saleEndsAt: new Date(NOW.getTime() + DAY) }, NOW)).toBe(
      15000,
    );
  });
});
