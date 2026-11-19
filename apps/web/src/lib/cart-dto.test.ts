import { describe, expect, it } from "vitest";
import { priceLines, type CartLineView, type CartView, type PricedLine } from "@ecom/core";
import { QUANTITY_FACTOR, netFromGross, parseQuantity, quantityFromTicks } from "@ecom/shared";
import { formatMoney } from "./money-input";
import { EMPTY_CART_VIEW, toCartDto } from "./cart-dto";

const FORMAT = { currency: "RON", locale: "ro-RO" };

function priced(over: Partial<PricedLine> = {}): PricedLine {
  return {
    key: "v1",
    basis: "unit",
    unitPriceMinor: 12345,
    priceSource: "public",
    publicLineMinor: 75181,
    afterGroupMinor: 75181,
    groupAdvantageMinor: 0,
    couponMinor: 0,
    totalMinor: 75181,
    netMinor: 62133,
    vatMinor: 13048,
    taxRateBps: 2100,
    ...over,
  };
}

function line(over: Partial<CartLineView> = {}): CartLineView {
  return {
    variantId: "v1",
    productId: "p1",
    productSlug: "mozaic-albastru",
    productTitle: "Mozaic albastru",
    variantLabel: null,
    sku: "MZ-1",
    image: null,
    energyClass: null,
    quantityTicks: "60900",
    stepTicks: "20300",
    minSteps: null,
    unit: { symbol: "mp", decimals: 4 },
    stepLabel: "cutie",
    basis: "unit",
    state: "in_stock",
    leadTimeDays: null,
    remainingSteps: null,
    issues: [],
    included: true,
    pricing: priced(),
    ...over,
  };
}

function view(lines: CartLineView[], over: Partial<CartView> = {}): CartView {
  return {
    lines,
    totals: { ...EMPTY_CART_VIEW.totals, totalMinor: 75181, vatMinor: 13048, netMinor: 62133 },
    leadTime: null,
    freeShipping: null,
    canCheckout: true,
    ...over,
  };
}

describe("coșul pentru interfață (texte gata formatate pe server)", () => {
  it("linie pe unitate cu pas fracționar: cantitate, pasul, preț unitar și total", () => {
    const dto = toCartDto(view([line()]), FORMAT);
    const l = dto.lines[0]!;
    expect(l.quantityText).toBe("6,09 mp");
    expect(l.steps).toBe(3);
    expect(l.stepNote).toBe("Se vinde în multipli de 2,03 mp (cutie)");
    expect(l.unitPriceText).toContain("123,45");
    expect(l.unitPriceText).toContain("/ mp");
    expect(l.totalText).toContain("751,81");
    expect(l.href).toBe("/produs/mozaic-albastru");
    expect(dto.totals?.totalText).toContain("751,81");
    expect(dto.totals?.vatText).toContain("130,48");
  });

  it("bucăți (pas = o unitate): fără notă despre pas", () => {
    const dto = toCartDto(
      view([
        line({
          quantityTicks: "30000",
          stepTicks: "10000",
          unit: { symbol: "buc", decimals: 0 },
          stepLabel: null,
        }),
      ]),
      FORMAT,
    );
    expect(dto.lines[0]!.stepNote).toBeNull();
    expect(dto.lines[0]!.quantityText).toBe("3 buc");
    expect(dto.lines[0]!.steps).toBe(3);
  });

  it("baza «pe pas»: prețul arată pasul (sac de 25 kg)", () => {
    const dto = toCartDto(
      view([
        line({
          basis: "step",
          quantityTicks: "500000",
          stepTicks: "250000",
          unit: { symbol: "kg", decimals: 4 },
          stepLabel: "sac",
          pricing: priced({ basis: "step", unitPriceMinor: 12000, totalMinor: 24000 }),
        }),
      ]),
      FORMAT,
    );
    expect(dto.lines[0]!.unitPriceText).toContain("120,00");
    expect(dto.lines[0]!.unitPriceText).toContain("/ sac de 25 kg");
    expect(dto.lines[0]!.steps).toBe(2);
  });

  it("linie indisponibilă: fără total, cu acțiunea de scoatere; nu intră în sumar", () => {
    const dto = toCartDto(
      view(
        [
          line({
            state: "unavailable",
            included: false,
            pricing: null,
            issues: [{ type: "unavailable" }],
          }),
        ],
        {
          totals: EMPTY_CART_VIEW.totals,
          canCheckout: false,
        },
      ),
      FORMAT,
    );
    const l = dto.lines[0]!;
    expect(l.totalText).toBeNull();
    expect(l.unitPriceText).toBeNull();
    expect(l.stateLabel).toBe("Indisponibil");
    expect(l.issues[0]).toMatchObject({ type: "unavailable", action: { kind: "remove" } });
    expect(dto.totals).toBeNull();
  });

  it("stoc scăzut: mesaj cu cât e disponibil și acțiune de ajustare la exact acea cantitate", () => {
    const dto = toCartDto(
      view([line({ issues: [{ type: "exceeds_available", maxSteps: 2 }] })]),
      FORMAT,
    );
    const issue = dto.lines[0]!.issues[0]!;
    expect(issue.message).toBe("Sunt disponibile doar 4,06 mp.");
    expect(issue.action).toEqual({
      kind: "adjust",
      quantityTicks: "40600",
      label: "Ajustează la 4,06 mp",
    });
  });

  it("preț schimbat: mesaj cu vechiul și noul preț, cu confirmare", () => {
    const dto = toCartDto(
      view([line({ issues: [{ type: "price_changed", fromMinor: 12345, toMinor: 13345 }] })]),
      FORMAT,
    );
    const issue = dto.lines[0]!.issues[0]!;
    expect(issue.message).toContain("123,45");
    expect(issue.message).toContain("133,45");
    expect(issue.action).toMatchObject({ kind: "acknowledge" });
  });

  it("cantitate devenită invalidă (pas schimbat): ajustare la cel mai apropiat multiplu, cel puțin minimul", () => {
    const dto = toCartDto(
      view([
        line({
          quantityTicks: "70000",
          minSteps: 2,
          issues: [{ type: "invalid_quantity", detail: "not_multiple_of_step" }],
        }),
      ]),
      FORMAT,
    );
    // 7 mp / 2,03 = 3 pași întregi → 6,09
    expect(dto.lines[0]!.issues[0]!.action).toMatchObject({
      kind: "adjust",
      quantityTicks: "60900",
    });
  });

  it("coș mixt: termenul cel mai lung; prag de transport doar când e setat", () => {
    const withLead = toCartDto(view([line()], { leadTime: { days: 21, variantId: "v1" } }), FORMAT);
    expect(withLead.leadTimeText).toBe("Livrare toată odată, în aproximativ 21 de zile");
    expect(withLead.freeShipping).toBeNull();
    const withFree = toCartDto(
      view([line()], {
        freeShipping: { thresholdMinor: 150362, remainingMinor: 75181, reached: false },
      }),
      FORMAT,
    );
    expect(withFree.freeShipping).toMatchObject({ reached: false, percent: 50 });
    expect(withFree.freeShipping?.text).toContain("751,81");
    const reached = toCartDto(
      view([line()], { freeShipping: { thresholdMinor: 50000, remainingMinor: 0, reached: true } }),
      FORMAT,
    );
    expect(reached.freeShipping).toMatchObject({ reached: true, percent: 100 });
  });

  it("finalizarea se activează doar când coșul nu are probleme, iar transportul se calculează la finalizare; nicio reducere în coș", () => {
    const dto = toCartDto(view([line()]), FORMAT);
    expect(dto.canCheckout).toBe(true);
    expect(dto.checkoutLabel).toBe("Finalizează comanda");
    expect(dto.checkoutBlockedNote).toContain("Rezolvă mai întâi");
    expect(dto.shippingNote).toBe("Transportul se calculează la finalizarea comenzii");
    expect(JSON.stringify(dto).toLowerCase()).not.toContain("reducere");
    expect(JSON.stringify(dto)).not.toContain("compareAt");
  });

  it("coș gol: fără linii și fără sumar", () => {
    const dto = toCartDto(EMPTY_CART_VIEW, FORMAT);
    expect(dto).toMatchObject({ lines: [], count: 0, totals: null });
  });
});

describe("TVA afișat în coș = TVA din motor (coș cu 3 linii, cu fracțiuni de ban)", () => {
  // aceleași linii ca în capturile de verificare: 751,81 + 240,00 + 9.490,00 = 10.481,81 lei
  const ONE = quantityFromTicks(QUANTITY_FACTOR);
  const input = (
    key: string,
    priceMinor: number,
    quantity: string,
    step: string,
    basis: "unit" | "step",
  ) => ({
    key,
    productId: `p-${key}`,
    categoryIds: [] as string[],
    basis,
    priceMinor,
    salePriceMinor: null,
    quantity: parseQuantity(quantity, { maxDecimals: 4 }),
    step: step === "1" ? ONE : parseQuantity(step, { maxDecimals: 4 }),
    taxRateBps: 2100,
    excludeFromGroupDiscount: false,
  });
  const engine = priceLines(
    [
      input("a", 12345, "6,09", "2,03", "unit"),
      input("b", 12000, "50", "25", "step"),
      input("c", 949000, "1", "1", "unit"),
    ],
    {
      applySale: false,
      group: { pricingType: "none" },
      now: new Date(0),
      maxLineMinor: 1_000_000_000,
    },
  );

  const cartView = (): CartView => ({
    lines: engine.lines.map((pricing) =>
      line({ variantId: pricing.key, productSlug: pricing.key, pricing, included: true }),
    ),
    totals: engine.totals,
    leadTime: null,
    freeShipping: null,
    canCheckout: true,
  });
  const money = (minor: number) => formatMoney(minor, FORMAT.currency, FORMAT.locale);

  it("motorul: TVA-ul coșului e SUMA TVA-urilor pe linii, fiecare extras din totalul liniei; net + TVA = brut", () => {
    expect(engine.lines.map((l) => l.totalMinor)).toEqual([75181, 24000, 949000]);
    expect(engine.lines.map((l) => l.vatMinor)).toEqual([13048, 4165, 164702]);
    expect(engine.totals.totalMinor).toBe(1048181);
    expect(engine.totals.vatMinor).toBe(181915); // 1.819,15 lei, nu 1.819,16 (extras din total) și nu 1.819,06
    expect(engine.totals.netMinor + engine.totals.vatMinor).toBe(engine.totals.totalMinor);
    // diferența față de extragerea din totalul general e de 1 ban: de aceea regula e scrisă și testată
    expect(engine.totals.totalMinor - netFromGross(engine.totals.totalMinor, 2100)).toBe(181916);
  });

  it("interfața arată exact TVA-ul din motor (suma pe linii), nu unul recalculat din total", () => {
    const dto = toCartDto(cartView(), FORMAT);
    expect(dto.totals?.vatText).toBe(money(engine.totals.vatMinor));
    expect(dto.totals?.vatText).toBe(money(engine.lines.reduce((acc, l) => acc + l.vatMinor, 0)));
    expect(dto.totals?.totalText).toBe(
      money(engine.lines.reduce((acc, l) => acc + l.totalMinor, 0)),
    );
    expect(dto.totals?.vatText).toContain("1.819,15");
  });
});
