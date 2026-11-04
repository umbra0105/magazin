import { describe, expect, it } from "vitest";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { StockError } from "./stock-errors";
import {
  STOCK_ACTIVATION_MAX_VARIANTS,
  checkActivationConfirm,
  computeActivationHash,
  planStockActivation,
  selectActivationTargets,
  type ActivationCatalogVariant,
} from "./stock-activation-plan";
import type { StockReportRow } from "./stock-report-plan";

/**
 * Planul PUR al pornirii în masă a gestionării stocului (12e): ce variante se pornesc (potrivite în fișier și, la cerere,
 * cele fără potrivire, cu stoc 0), la ce nivel (produs sau variantă), ce rămâne neatins (oprite explicit, digitale) și
 * ce se aplică. Fără bază de date și fără fișiere. Date inventate.
 */

const q = (text: string): Quantity => parseQuantity(text);
const MAIN = "Gestiune principala";
const FILE_HASH = "c".repeat(64);

let rowNo = 0;
const row = (code: string, over: Partial<StockReportRow> = {}): StockReportRow => {
  rowNo += 1;
  return { rowNumber: 10 + rowNo, warehouse: MAIN, code, unit: "BUC", quantity: 1, ...over };
};

interface VariantOver {
  productManage?: boolean;
  variantManage?: boolean | null;
  digital?: boolean;
  currentPhysical?: Quantity | null;
  expectedUnit?: string | null;
}

/** O variantă de catalog; `effective` = bifa efectivă (varianta peste produs), exact ca în încărcătorul real. */
function variant(productId: string, sku: string, over: VariantOver = {}): ActivationCatalogVariant {
  const productManage = over.productManage ?? false;
  const variantManage = over.variantManage ?? null;
  const digital = over.digital ?? false;
  const effective = digital ? false : (variantManage ?? productManage);
  return {
    variantId: `var-${sku}`,
    productId,
    productTitle: `Produs ${productId}`,
    sku,
    digital,
    productManage,
    variantManage,
    report: {
      variantId: `var-${sku}`,
      sku,
      label: `Produs ${productId} · ${sku}`,
      manageStock: effective,
      expectedUnit: over.expectedUnit === undefined ? "buc" : over.expectedUnit,
      conversion: { mode: "same_unit" },
      currentPhysical: over.currentPhysical ?? null,
    },
  };
}

const plan = (
  rows: StockReportRow[],
  catalog: ActivationCatalogVariant[],
  options: { startUnmatched?: boolean; maxVariants?: number } = {},
) =>
  planStockActivation({
    rows,
    warehouses: [MAIN],
    catalog,
    startUnmatched: options.startUnmatched ?? false,
    maxVariants: options.maxVariants ?? STOCK_ACTIVATION_MAX_VARIANTS,
  });

const stockCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof StockError) return error.code;
    throw error;
  }
  return "NO_ERROR";
};

describe("planStockActivation: nivelul pornirii", () => {
  it("produs acoperit întreg de fișier, fără suprascrieri: se pornește produsul", () => {
    const p = plan([row("A1"), row("A2")], [variant("P1", "A1"), variant("P1", "A2")]);
    expect(p.canApply).toBe(true);
    expect(p.changes).toEqual([
      { scope: "product", id: "P1", productId: "P1", variantIds: ["var-A1", "var-A2"] },
    ]);
    expect(p.counters).toMatchObject({ products: 1, matched: 2, zero: 0 });
  });

  it("produs acoperit doar parțial: se pornesc DOAR variantele din fișier, pe variantă", () => {
    const p = plan([row("A1")], [variant("P1", "A1"), variant("P1", "A2")]);
    expect(p.changes).toEqual([
      { scope: "variant", id: "var-A1", productId: "P1", variantIds: ["var-A1"] },
    ]);
    // fratele fără potrivire rămâne negestionat, dar e listat ca posibil de pornit la stoc 0
    expect(p.unmatchedEligible.map((v) => v.sku)).toEqual(["A2"]);
    expect(p.counters).toMatchObject({ products: 1, matched: 1, zero: 0, unmatchedEligible: 1 });
  });

  it("cu opțiunea «fără potrivire, cu stoc 0», fratele intră și produsul se pornește întreg", () => {
    const p = plan([row("A1")], [variant("P1", "A1"), variant("P1", "A2")], {
      startUnmatched: true,
    });
    expect(p.changes).toEqual([
      { scope: "product", id: "P1", productId: "P1", variantIds: ["var-A1", "var-A2"] },
    ]);
    expect(p.counters).toMatchObject({ products: 1, matched: 1, zero: 1 });
    expect(p.enabled.zero.map((v) => v.sku)).toEqual(["A2"]);
  });

  it("fără opțiune, variantele fără potrivire nu intră nicăieri", () => {
    const p = plan([row("A1")], [variant("P1", "A1"), variant("P2", "B1")]);
    expect(p.enabled.zero).toEqual([]);
    expect(p.changes.map((c) => c.id)).toEqual(["P1"]);
    expect(p.unmatchedEligible.map((v) => v.sku)).toEqual(["B1"]);
  });

  it("opțiunea singură, fără nicio potrivire în fișier, pornește variantele la 0", () => {
    const p = plan([row("ALTCEVA")], [variant("P1", "A1"), variant("P2", "B1")], {
      startUnmatched: true,
    });
    expect(p.counters).toMatchObject({ products: 2, matched: 0, zero: 2 });
    expect(p.changes.map((c) => [c.scope, c.id])).toEqual([
      ["product", "P1"],
      ["product", "P2"],
    ]);
    expect(p.report.unknownCodes).toHaveLength(1);
  });

  it("o variantă oprită explicit pe variantă nu se atinge și împiedică pornirea la nivel de produs", () => {
    const catalog = [
      variant("P1", "A1"),
      variant("P1", "A2", { variantManage: false }),
      variant("P1", "A3"),
    ];
    const p = plan([row("A1"), row("A2"), row("A3")], catalog, { startUnmatched: true });
    expect(p.changes.map((c) => [c.scope, c.id])).toEqual([
      ["variant", "var-A1"],
      ["variant", "var-A3"],
    ]);
    expect(p.counters.explicitOff).toBe(1);
    // A2 apare în fișier, dar rămâne neatinsă, cu motiv
    expect(p.untouched).toEqual([expect.objectContaining({ sku: "A2", reason: "explicit_off" })]);
    expect(p.enabled.zero.map((v) => v.sku)).toEqual([]);
  });

  it("produsele digitale nu se pornesc niciodată, nici cu opțiunea", () => {
    const catalog = [variant("D1", "G1", { digital: true }), variant("P1", "A1")];
    const p = plan([row("G1"), row("A1")], catalog, { startUnmatched: true });
    expect(p.changes.map((c) => c.id)).toEqual(["P1"]);
    expect(p.counters.digital).toBe(1);
    expect(p.untouched).toEqual([expect.objectContaining({ sku: "G1", reason: "digital" })]);
    expect(p.unmatchedEligible).toEqual([]);
  });

  it("varianta deja gestionată nu se schimbă, dar cantitatea ei din fișier se aplică", () => {
    const catalog = [
      variant("P1", "A1", { productManage: true, currentPhysical: q("2") }),
      variant("P2", "B1"),
    ];
    const p = plan([row("A1", { quantity: 7 }), row("B1")], catalog);
    expect(p.counters).toMatchObject({ alreadyManaged: 1, matched: 1, products: 1 });
    expect(p.changes.map((c) => c.id)).toEqual(["P2"]);
    expect(p.report.lines.map((l) => l.sku).sort()).toEqual(["A1", "B1"]);
  });

  it("produs oprit, cu o variantă deja gestionată pe variantă și frații în fișier: nivel de produs", () => {
    const catalog = [variant("P1", "A1", { variantManage: true }), variant("P1", "A2")];
    const p = plan([row("A1"), row("A2")], catalog);
    expect(p.changes).toEqual([
      { scope: "product", id: "P1", productId: "P1", variantIds: ["var-A2"] },
    ]);
    expect(p.counters).toMatchObject({ alreadyManaged: 1, matched: 1 });
  });

  it("modificările ies în ordine fixă (după identificator), indiferent de ordinea din catalog", () => {
    const catalog = [variant("P9", "Z1"), variant("P1", "A1"), variant("P5", "M1")];
    const p = plan([row("Z1"), row("A1"), row("M1")], catalog);
    expect(p.changes.map((c) => c.id)).toEqual(["P1", "P5", "P9"]);
  });
});

describe("planStockActivation: ce blochează aplicarea", () => {
  it("nimic de pornit: nu se aplică (pentru cantități există importul obișnuit)", () => {
    const p = plan([row("A1")], [variant("P1", "A1", { productManage: true })]);
    expect(p.nothingToEnable).toBe(true);
    expect(p.canApply).toBe(false);
  });

  it("peste plafon: nu se aplică, iar planul spune câte variante ar porni", () => {
    const catalog = [variant("P1", "A1"), variant("P2", "B1"), variant("P3", "C1")];
    const p = plan([row("A1"), row("B1"), row("C1")], catalog, { maxVariants: 2 });
    expect(p.tooMany).toBe(true);
    expect(p.canApply).toBe(false);
    expect(p.counters.matched).toBe(3);
    const exact = plan([row("A1"), row("B1"), row("C1")], catalog, { maxVariants: 3 });
    expect(exact.tooMany).toBe(false);
    expect(exact.canApply).toBe(true);
  });

  it("plafonul numără și variantele pornite la 0", () => {
    const catalog = [variant("P1", "A1"), variant("P2", "B1"), variant("P3", "C1")];
    const p = plan([row("A1")], catalog, { maxVariants: 2, startUnmatched: true });
    expect(p.tooMany).toBe(true);
    expect(plan([row("A1")], catalog, { maxVariants: 2 }).tooMany).toBe(false);
  });

  it("erori de rând din raport (unitate greșită) blochează tot", () => {
    const p = plan([row("A1", { unit: "KG" })], [variant("P1", "A1")]);
    expect(p.report.canApply).toBe(false);
    expect(p.canApply).toBe(false);
  });

  it("o eroare de rând blochează aplicarea chiar dacă alte variante ar porni", () => {
    const p = plan(
      [row("A1"), row("B1", { unit: "KG" })],
      [variant("P1", "A1"), variant("P2", "B1")],
    );
    expect(p.counters.matched).toBe(1);
    expect(p.nothingToEnable).toBe(false);
    expect(p.report.canApply).toBe(false);
    expect(p.canApply).toBe(false);
  });

  it("variantele care vor fi pornite sunt verificate ca gestionate: unitatea lor se compară cu fișierul", () => {
    const p = plan([row("A1", { unit: "MP" })], [variant("P1", "A1")]);
    expect(p.report.errors.map((e) => e.kind)).toEqual(["unit_mismatch"]);
  });
});

describe("selectActivationTargets", () => {
  const catalog = [
    variant("P1", "B1"),
    variant("P1", "A1"),
    variant("P2", "M1", { productManage: true }),
    variant("P3", "N1"),
  ];
  const rows = [row("B1", { quantity: 2 }), row("A1", { quantity: 5 }), row("M1", { quantity: 3 })];

  it("fără opțiune: doar liniile din fișier (pornite și deja gestionate), în ordinea fixă de blocare", () => {
    const p = plan(rows, catalog);
    expect(selectActivationTargets(p).map((t) => [t.variantId, t.kind, t.quantity])).toEqual([
      ["var-A1", "file", q("5")],
      ["var-B1", "file", q("2")],
      ["var-M1", "file", q("3")],
    ]);
  });

  it("cu opțiunea: variantele fără potrivire primesc 0, amestecate în aceeași ordine fixă", () => {
    const p = plan(rows, catalog, { startUnmatched: true });
    expect(selectActivationTargets(p).map((t) => [t.variantId, t.kind, t.quantity])).toEqual([
      ["var-A1", "file", q("5")],
      ["var-B1", "file", q("2")],
      ["var-M1", "file", q("3")],
      ["var-N1", "zeroed", 0n],
    ]);
  });

  it("un plan care nu se poate aplica nu produce ținte", () => {
    const p = plan([row("A1", { unit: "KG" })], [variant("P1", "A1")]);
    expect(stockCode(() => selectActivationTargets(p))).toBe("STOCK_ACTIVATION_NOT_APPLICABLE");
  });
});

describe("checkActivationConfirm", () => {
  const catalog = [variant("P1", "A1"), variant("P2", "B1"), variant("P3", "C1")];
  const p = plan([row("A1"), row("B1")], catalog, { startUnmatched: true });
  // produse: 3, potrivite: 2, la 0: 1

  it("numerele exacte din previzualizare trec", () => {
    expect(() => checkActivationConfirm(p, { products: 3, variants: 2, zero: 1 })).not.toThrow();
  });

  it("orice număr diferit se refuză, cu codul stabil", () => {
    for (const bad of [
      { products: 2, variants: 2, zero: 1 },
      { products: 3, variants: 3, zero: 1 },
      { products: 3, variants: 2, zero: 0 },
      { products: 3, variants: 2, zero: 2 },
    ]) {
      expect(stockCode(() => checkActivationConfirm(p, bad))).toBe(
        "STOCK_ACTIVATION_COUNT_MISMATCH",
      );
    }
  });

  it("fără opțiune, numărul de variante la 0 confirmat trebuie să fie 0", () => {
    const without = plan([row("A1"), row("B1")], catalog);
    expect(() =>
      checkActivationConfirm(without, { products: 2, variants: 2, zero: 0 }),
    ).not.toThrow();
    expect(
      stockCode(() => checkActivationConfirm(without, { products: 2, variants: 2, zero: 1 })),
    ).toBe("STOCK_ACTIVATION_COUNT_MISMATCH");
  });
});

describe("computeActivationHash", () => {
  const rows = [row("A1"), row("B1")];
  const catalog = [variant("P1", "A1"), variant("P2", "B1"), variant("P3", "C1")];
  const hash = (
    c = catalog,
    options: { startUnmatched?: boolean } = {},
    file = FILE_HASH,
    warehouses = [MAIN],
  ) =>
    computeActivationHash({
      fileHash: file,
      warehouses,
      startUnmatched: options.startUnmatched ?? false,
      plan: plan(rows, c, options),
    });

  it("aceleași date dau aceeași amprentă, indiferent de ordinea catalogului", () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
    expect(hash([...catalog].reverse())).toBe(hash());
  });

  it("opțiunea «fără potrivire, cu stoc 0» schimbă amprenta", () => {
    expect(hash(catalog, { startUnmatched: true })).not.toBe(hash());
  });

  it("o bifă schimbată în catalog după previzualizare schimbă amprenta", () => {
    const flipped = [
      variant("P1", "A1", { productManage: true }),
      variant("P2", "B1"),
      variant("P3", "C1"),
    ];
    expect(hash(flipped)).not.toBe(hash());
    const off = [
      variant("P1", "A1", { variantManage: false }),
      variant("P2", "B1"),
      variant("P3", "C1"),
    ];
    expect(hash(off)).not.toBe(hash());
  });

  it("un produs devenit parțial acoperit (nivel produs → variantă) schimbă amprenta", () => {
    const wider = [...catalog, variant("P1", "A9")];
    expect(hash(wider)).not.toBe(hash());
  });

  it("alt fișier sau alte gestiuni alese schimbă amprenta", () => {
    expect(hash(catalog, {}, "d".repeat(64))).not.toBe(hash());
    expect(hash(catalog, {}, FILE_HASH, [MAIN, "Alta"])).not.toBe(hash());
  });

  it("opțiunea schimbă amprenta și când nu există nicio variantă fără potrivire", () => {
    const only = [variant("P1", "A1"), variant("P2", "B1")];
    const without = computeActivationHash({
      fileHash: FILE_HASH,
      warehouses: [MAIN],
      startUnmatched: false,
      plan: plan(rows, only),
    });
    const withOption = computeActivationHash({
      fileHash: FILE_HASH,
      warehouses: [MAIN],
      startUnmatched: true,
      plan: plan(rows, only, { startUnmatched: true }),
    });
    expect(withOption).not.toBe(without);
  });

  it("o variantă nouă fără potrivire schimbă amprenta, cu opțiunea activă", () => {
    const more = [...catalog, variant("P4", "D1")];
    expect(hash(more, { startUnmatched: true })).not.toBe(hash(catalog, { startUnmatched: true }));
  });
});
