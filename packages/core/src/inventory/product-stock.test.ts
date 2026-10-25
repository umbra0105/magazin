import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity, saleStepToInt, type Quantity } from "@ecom/shared";
import { buildStockOverviewRow, type StockOverviewSource } from "./stock-overview";
import { redactRowQuantities, resolveLeadTime, summarizeProductRows } from "./product-stock";

/**
 * Faza 5, punctul 9a: rezumatul stocului unui produs (tabul Stoc din produs și coloana «Stoc» din listă) și termenul de
 * livrare efectiv cu proveniența lui. Funcții PURE, pe rânduri construite ca în ecranul de stoc.
 */

const q = (text: string): Quantity => parseQuantity(text);
const settings = { defaultLowStockSteps: 2, defaultLeadTimeDays: 14 };
const MP = { code: "mp", symbol: "mp", decimals: 2 };
const ML = { code: "ml", symbol: "ml", decimals: 1 };

function source(
  overrides: Partial<StockOverviewSource> & { step?: string; physical?: string | null },
) {
  const { step, physical, ...rest } = overrides;
  return buildStockOverviewRow(
    {
      variantId: "v1",
      sku: "SKU-1",
      variantLabel: null,
      productId: "p1",
      productTitle: "Produs",
      productSlug: "produs",
      productType: "physical",
      manageStock: true,
      stockStatus: "instock",
      allowBackorder: false,
      unit: MP,
      saleStep: saleStepToInt(q(step ?? "1")),
      minSteps: null,
      item:
        physical === null
          ? null
          : {
              physical: q(physical ?? "0"),
              physicalAsOf: null,
              committed: 0n as Quantity,
              reserved: 0n as Quantity,
              safetyBuffer: 0n as Quantity,
              lowStockSteps: null,
            },
      leadTime: { productDays: null, brandDays: null },
      ...rest,
    },
    settings,
  );
}

describe("termenul de livrare efectiv și proveniența lui", () => {
  it("produsul bate brandul, brandul bate setarea globală; 0 zile e o valoare, nu «lipsă»", () => {
    expect(resolveLeadTime({ productDays: 5, brandDays: 10 }, 14)).toEqual({
      days: 5,
      origin: "product",
    });
    expect(resolveLeadTime({ productDays: null, brandDays: 10 }, 14)).toEqual({
      days: 10,
      origin: "brand",
    });
    expect(resolveLeadTime({ productDays: null, brandDays: null }, 14)).toEqual({
      days: 14,
      origin: "global",
    });
    expect(resolveLeadTime({ productDays: 0, brandDays: 10 }, 14)).toEqual({
      days: 0,
      origin: "product",
    });
    expect(resolveLeadTime({ productDays: null, brandDays: 0 }, 14)).toEqual({
      days: 0,
      origin: "brand",
    });
  });

  it("refuză zile invalide (nu le ascunde)", () => {
    expect(() => resolveLeadTime({ productDays: -1, brandDays: null }, 14)).toThrow();
    expect(() => resolveLeadTime({ productDays: null, brandDays: null }, 366)).toThrow();
  });
});

describe("rezumatul unui produs", () => {
  it("o variantă gestionată: starea ei și cantitatea disponibilă în unitatea ei", () => {
    const summary = summarizeProductRows([source({ physical: "100", step: "2,5", unit: ML })], {
      withQuantities: true,
    });
    expect(summary).toMatchObject({
      kind: "managed",
      state: "in_stock",
      variantCount: 1,
      notInventoried: false,
    });
    expect(summary.quantity && formatQuantity(summary.quantity.available)).toBe("100");
    expect(summary.quantity?.unit.symbol).toBe("ml");
  });

  it("mai multe variante: starea cea mai bună, suma disponibilului când unitatea e aceeași", () => {
    const rows = [
      source({ variantId: "a", physical: "0" }),
      source({ variantId: "b", physical: "7" }),
      source({ variantId: "c", physical: "3" }),
    ];
    const summary = summarizeProductRows(rows, { withQuantities: true });
    expect(summary.state).toBe("in_stock");
    expect(summary.variantCount).toBe(3);
    expect(summary.quantity && formatQuantity(summary.quantity.available)).toBe("10");
  });

  it("unități diferite: fără sumă, cu semn explicit", () => {
    const summary = summarizeProductRows(
      [
        source({ variantId: "a", physical: "5" }),
        source({ variantId: "b", physical: "5", unit: ML }),
      ],
      { withQuantities: true },
    );
    expect(summary.quantity).toBeNull();
    expect(summary.differentUnits).toBe(true);
  });

  it("ordinea stărilor: În stoc > Stoc limitat > La comandă > Indisponibil", () => {
    const limited = source({ variantId: "l", physical: "2" }); // 2 pași = pragul
    const unavailable = source({ variantId: "u", physical: "0" });
    const onOrder = source({
      variantId: "o",
      manageStock: false,
      stockStatus: "onbackorder",
      leadTime: { productDays: 9, brandDays: null },
    });
    expect(summarizeProductRows([unavailable], { withQuantities: false }).state).toBe(
      "unavailable",
    );
    expect(summarizeProductRows([unavailable, onOrder], { withQuantities: false }).state).toBe(
      "on_order",
    );
    expect(
      summarizeProductRows([unavailable, onOrder, limited], { withQuantities: false }).state,
    ).toBe("limited");
    const inStock = source({ variantId: "s", physical: "50" });
    expect(
      summarizeProductRows([unavailable, onOrder, limited, inStock], { withQuantities: false })
        .state,
    ).toBe("in_stock");
  });

  it("«La comandă»: termenul cel mai scurt dintre variantele la comandă; altfel fără termen", () => {
    const a = source({
      variantId: "a",
      manageStock: false,
      stockStatus: "onbackorder",
      leadTime: { productDays: 20, brandDays: null },
    });
    const b = source({
      variantId: "b",
      manageStock: false,
      stockStatus: "onbackorder",
      leadTime: { productDays: 6, brandDays: null },
    });
    expect(summarizeProductRows([a, b], { withQuantities: false })).toMatchObject({
      state: "on_order",
      leadTimeDays: 6,
    });
    expect(
      summarizeProductRows([source({ physical: "50" })], { withQuantities: false }).leadTimeDays,
    ).toBeNull();
  });

  it("hibrid: produsul gestionat epuizat cu allowBackorder e «La comandă» cu termenul din brand", () => {
    const row = source({
      physical: "0",
      allowBackorder: true,
      leadTime: { productDays: null, brandDays: 8 },
    });
    expect(summarizeProductRows([row], { withQuantities: true })).toMatchObject({
      state: "on_order",
      leadTimeDays: 8,
    });
  });

  it("negestionat: fără cantitate, cu starea aleasă; digital: În stoc, fără cantitate", () => {
    const unmanaged = summarizeProductRows(
      [source({ manageStock: false, stockStatus: "outofstock" })],
      { withQuantities: true },
    );
    expect(unmanaged).toMatchObject({ kind: "unmanaged", state: "unavailable", quantity: null });
    const digital = summarizeProductRows([source({ productType: "digital" })], {
      withQuantities: true,
    });
    expect(digital).toMatchObject({ kind: "digital", state: "in_stock", quantity: null });
  });

  it("variante de tipuri diferite: «mixed», cantitate doar din cele gestionate", () => {
    const summary = summarizeProductRows(
      [source({ variantId: "a", physical: "4" }), source({ variantId: "b", manageStock: false })],
      { withQuantities: true },
    );
    expect(summary.kind).toBe("mixed");
    expect(summary.quantity && formatQuantity(summary.quantity.available)).toBe("4");
  });

  it("gestionat dar încă fără inventar: semnalat, cantitate zero", () => {
    const summary = summarizeProductRows([source({ physical: null })], { withQuantities: true });
    expect(summary.notInventoried).toBe(true);
    expect(summary.quantity && formatQuantity(summary.quantity.available)).toBe("0");
  });

  it("fără drept de cantități: nicio cantitate nu iese din rezumat, starea rămâne", () => {
    const rows = [
      source({ variantId: "a", physical: "100" }),
      source({ variantId: "b", physical: "3" }),
    ];
    const summary = summarizeProductRows(rows, { withQuantities: false });
    expect(summary.quantity).toBeNull();
    expect(summary.differentUnits).toBe(false);
    expect(summary.state).toBe("in_stock");
    expect(
      JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain("1000000");
  });

  it("fără rânduri: eroare clară, nu o stare inventată", () => {
    expect(() => summarizeProductRows([], { withQuantities: true })).toThrow();
  });
});

describe("redactRowQuantities (pentru cine nu are inventory.read)", () => {
  const row = source({ physical: "100", step: "2,5", unit: ML });

  it("scoate toate cantitățile și derivatele lor, păstrează starea, unitatea, pasul și termenul", () => {
    const redacted = redactRowQuantities(row);
    for (const key of [
      "physical",
      "committed",
      "reserved",
      "safetyBuffer",
      "available",
      "sellable",
      "availableSteps",
      "remainder",
      "physicalAsOf",
    ] as const) {
      expect(redacted[key], key).toBeNull();
    }
    expect(redacted.lowStock).toBe(false);
    expect(redacted.remainderOnly).toBe(false);
    expect(redacted).toMatchObject({
      state: row.state,
      kind: row.kind,
      unit: row.unit,
      step: row.step,
      sku: row.sku,
    });
  });

  it("nu modifică rândul original", () => {
    redactRowQuantities(row);
    expect(row.physical).not.toBeNull();
  });
});
