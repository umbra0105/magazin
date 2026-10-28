import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity, type Quantity } from "@ecom/shared";
import { StockError } from "./stock-errors";
import {
  planStockReport,
  type StockReportConversion,
  type StockReportRow,
  type StockReportVariant,
} from "./stock-report-plan";

/**
 * Fișier FABRICAT, cu structura raportului SmartBill «Stoc la zi» (gestiune, cod, U.M., stoc final). Niciun cod,
 * nicio denumire și nicio cantitate nu vin din fișierul real.
 */

const q = (text: string): Quantity => parseQuantity(text);
const fmt = (value: Quantity): string => formatQuantity(value);

const MAIN = "Gestiune principala";

let rowNo = 0;
function row(over: Partial<StockReportRow> & { code: string | null }): StockReportRow {
  rowNo += 1;
  return {
    rowNumber: over.rowNumber ?? 10 + rowNo,
    warehouse: MAIN,
    unit: "BUC",
    quantity: 1,
    ...over,
  };
}

function variant(
  sku: string,
  over: Partial<StockReportVariant> & { conversion?: StockReportConversion } = {},
): StockReportVariant {
  return {
    variantId: `var-${sku}`,
    sku,
    label: `Produs ${sku}`,
    manageStock: true,
    expectedUnit: "buc",
    conversion: { mode: "same_unit" },
    currentPhysical: null,
    ...over,
  };
}

const plan = (
  rows: StockReportRow[],
  variants: StockReportVariant[],
  warehouses: string[] = [MAIN],
) => planStockReport({ rows, warehouses, variants });

function stockCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof StockError) return error.code;
    throw error;
  }
  return "";
}

describe("gestiunile citite: setare, nu cod", () => {
  it("citește doar gestiunea aleasă; celelalte se ignoră cu contor", () => {
    const result = plan(
      [
        row({ code: "A1", quantity: 5 }),
        row({ code: "A2", quantity: 7, warehouse: "Alta gestiune" }),
        row({ code: "A3", quantity: 9, warehouse: "Total" }),
      ],
      [variant("A1"), variant("A2")],
    );
    expect(result.lines.map((l) => l.sku)).toEqual(["A1"]);
    expect(result.counters.otherWarehouses).toBe(2);
    expect(result.counters.rows).toBe(3);
    // A2 apare doar în altă gestiune: pentru gestiunea aleasă lipsește din fișier
    expect(result.missingManaged.map((m) => m.sku)).toEqual(["A2"]);
  });

  it("numele gestiunii se potrivește fără deosebire de litere și spații în plus", () => {
    const result = plan(
      [row({ code: "A1", quantity: 5, warehouse: "  GESTIUNE   principala " })],
      [variant("A1")],
    );
    expect(result.lines).toHaveLength(1);
  });

  it("se pot alege mai multe gestiuni", () => {
    const result = plan(
      [row({ code: "A1", quantity: 5 }), row({ code: "A2", quantity: 3, warehouse: "Depozit 2" })],
      [variant("A1"), variant("A2")],
      [MAIN, "Depozit 2"],
    );
    expect(result.lines.map((l) => l.sku).sort()).toEqual(["A1", "A2"]);
    expect(result.warehousesRead.sort()).toEqual(["Depozit 2", MAIN].sort());
  });

  it("fără nicio gestiune în setare: eroare clară, nu «citește tot»", () => {
    expect(stockCode(() => plan([row({ code: "A1" })], [variant("A1")], []))).toBe(
      "STOCK_REPORT_NO_WAREHOUSE",
    );
    expect(stockCode(() => plan([row({ code: "A1" })], [variant("A1")], ["  "]))).toBe(
      "STOCK_REPORT_NO_WAREHOUSE",
    );
  });

  it("gestiunea aleasă nu apare în fișier: eroare clară cu gestiunile găsite", () => {
    const rows = [row({ code: "A1", warehouse: "Alta" }), row({ code: "A2", warehouse: "Alta" })];
    expect(stockCode(() => plan(rows, [variant("A1")]))).toBe("STOCK_REPORT_WAREHOUSE_NOT_FOUND");
    try {
      plan(rows, [variant("A1")]);
    } catch (error) {
      expect((error as StockError).message).toContain(MAIN);
      expect((error as StockError).message).toContain("Alta");
    }
  });

  it("dacă măcar una din gestiunile alese lipsește, eroare (nu se citește pe jumătate)", () => {
    expect(
      stockCode(() => plan([row({ code: "A1" })], [variant("A1")], [MAIN, "Gestiune inexistenta"])),
    ).toBe("STOCK_REPORT_WAREHOUSE_NOT_FOUND");
  });

  it("fișier fără rânduri de date: eroare", () => {
    expect(stockCode(() => plan([], [variant("A1")]))).toBe("STOCK_REPORT_EMPTY");
  });
});

describe("cantități citite exact", () => {
  const one = (quantity: StockReportRow["quantity"], v = variant("A1")) =>
    plan([row({ code: "A1", quantity })], [v]);

  it("număr din .xls (dublu) și text: 2.35, «2,35» → 2,35", () => {
    expect(fmt(one(2.35).lines[0]!.quantity)).toBe("2,35");
    expect(fmt(one("2,35").lines[0]!.quantity)).toBe("2,35");
    expect(fmt(one("2.35").lines[0]!.quantity)).toBe("2,35");
  });

  it("0,1 + 0,2 nu apare: 0.30000000000000004 are mai mult de 4 zecimale și se refuză, nu se rotunjește", () => {
    const result = one(0.1 + 0.2);
    expect(result.lines).toHaveLength(0);
    expect(result.errors.map((e) => e.kind)).toEqual(["quantity_decimals"]);
  });

  it("trei zecimale se păstrează; patru se păstrează; cinci = eroare", () => {
    expect(fmt(one(2.348).lines[0]!.quantity)).toBe("2,348");
    expect(fmt(one("2,3481").lines[0]!.quantity)).toBe("2,3481");
    const five = one("2,34812");
    expect(five.lines).toHaveLength(0);
    expect(five.errors[0]?.kind).toBe("quantity_decimals");
    expect(five.errors[0]?.message).toContain("4 zecimale");
  });

  it("zecimale la o unitate fără zecimale (bucată) se păstrează exact", () => {
    expect(fmt(one(1.5).lines[0]!.quantity)).toBe("1,5");
  });

  it("zero se aplică (stoc epuizat), fără avertisment", () => {
    const result = one(0, variant("A1", { currentPhysical: q("5") }));
    expect(fmt(result.lines[0]!.quantity)).toBe("0");
    expect(result.lines[0]!.warnings).toEqual([]);
  });

  it("negativ în SmartBill: se aplică 0, cu avertisment", () => {
    const result = one(-3);
    expect(fmt(result.lines[0]!.quantity)).toBe("0");
    expect(result.lines[0]!.warnings).toEqual(["negative_set_to_zero"]);
    expect(result.warnings.map((w) => w.kind)).toContain("negative_set_to_zero");
    expect(result.canApply).toBe(true);
  });

  it("valori ilizibile: text, notație științifică, NaN, Infinity, mii cu separator", () => {
    for (const value of ["abc", "1e-7", 1e-7, Number.NaN, Number.POSITIVE_INFINITY, "1.234,5"]) {
      const result = one(value);
      expect(result.lines, String(value)).toHaveLength(0);
      expect(
        result.errors.map((e) => e.kind),
        String(value),
      ).toEqual(["quantity_invalid"]);
    }
  });

  it("peste plafon: eroare, nu se taie", () => {
    const result = one("999999999");
    expect(result.errors.map((e) => e.kind)).toEqual(["quantity_overflow"]);
  });

  it("cantitate lipsă (gol): rândul se ignoră cu contor, nu devine 0", () => {
    const result = one(null);
    expect(result.lines).toHaveLength(0);
    expect(result.counters.withoutQuantity).toBe(1);
    expect(result.errors).toEqual([]);
    // codul nu e «pus pe 0» doar pentru că rândul fără cantitate lipsește: apare la «lipsă din fișier»
    expect(result.missingManaged.map((m) => m.sku)).toEqual(["A1"]);
  });
});

describe("potrivirea pe SKU", () => {
  it("codul rămâne text: zerourile din față contează («01383» ≠ «1383»)", () => {
    const result = plan([row({ code: "01383", quantity: 4 })], [variant("01383"), variant("1383")]);
    expect(result.lines.map((l) => l.sku)).toEqual(["01383"]);
    expect(result.missingManaged.map((m) => m.sku)).toEqual(["1383"]);
  });

  it("codul din fișier se taie la spații, dar nu se schimbă altfel", () => {
    const result = plan([row({ code: "  A1 ", quantity: 2 })], [variant("A1")]);
    expect(result.lines).toHaveLength(1);
  });

  it("cod necunoscut: listat, nu se creează nimic și nu blochează aplicarea", () => {
    const result = plan(
      [row({ code: "A1", quantity: 2 }), row({ code: "ZZZ", quantity: 9, rowNumber: 99 })],
      [variant("A1")],
    );
    expect(result.unknownCodes).toEqual([{ rowNumber: 99, code: "ZZZ" }]);
    expect(result.lines).toHaveLength(1);
    expect(result.canApply).toBe(true);
  });

  it("cod lipsă pe un rând al gestiunii alese: eroare cu numărul rândului", () => {
    const result = plan([row({ code: null, quantity: 2, rowNumber: 42 })], [variant("A1")]);
    expect(result.errors).toMatchObject([{ kind: "missing_code", rowNumber: 42 }]);
    expect(result.canApply).toBe(false);
  });

  it("cod duplicat în gestiunea aleasă: eroare pe ambele rânduri, nimic nu se însumează", () => {
    const result = plan(
      [
        row({ code: "A1", quantity: 2, rowNumber: 11 }),
        row({ code: "A1", quantity: 3, rowNumber: 12 }),
        row({ code: "A2", quantity: 1, rowNumber: 13 }),
      ],
      [variant("A1"), variant("A2")],
    );
    expect(result.lines.map((l) => l.sku)).toEqual(["A2"]);
    const duplicates = result.errors.filter((e) => e.kind === "duplicate_code");
    expect(duplicates.map((e) => e.rowNumber)).toEqual([11, 12]);
    expect(duplicates[0]?.message).toContain("11");
    expect(duplicates[0]?.message).toContain("12");
    expect(result.canApply).toBe(false);
    // codul cu eroare nu apare și la «lipsă din fișier»
    expect(result.missingManaged).toEqual([]);
  });

  it("același cod în două gestiuni DIFERITE, doar una aleasă: nu e duplicat", () => {
    const result = plan(
      [row({ code: "A1", quantity: 2 }), row({ code: "A1", quantity: 8, warehouse: "Alta" })],
      [variant("A1")],
    );
    expect(result.errors).toEqual([]);
    expect(fmt(result.lines[0]!.quantity)).toBe("2");
  });

  it("același cod în două gestiuni ALESE: tot eroare (nu se însumează pe tăcute)", () => {
    const result = plan(
      [row({ code: "A1", quantity: 2 }), row({ code: "A1", quantity: 8, warehouse: "Depozit 2" })],
      [variant("A1")],
      [MAIN, "Depozit 2"],
    );
    expect(result.errors.map((e) => e.kind)).toEqual(["duplicate_code", "duplicate_code"]);
  });
});

describe("unități: normalizate, verificate față de varianta", () => {
  const withUnit = (fileUnit: string | null, expected: string | null, quantity = 3) =>
    plan(
      [row({ code: "A1", quantity, unit: fileUnit })],
      [variant("A1", { expectedUnit: expected })],
    );

  it("aceeași unitate scrisă diferit (M2 = mp, BUC = bucata) trece", () => {
    expect(withUnit("M2", "mp").lines).toHaveLength(1);
    expect(withUnit("MP", "M2").lines).toHaveLength(1);
    expect(withUnit("Bucata", "BUC").lines).toHaveLength(1);
    expect(withUnit("LT", "litri").lines).toHaveLength(1);
  });

  it("unitate diferită de cea a variantei: eroare în română, cu ambele unități", () => {
    const result = withUnit("KG", "buc");
    expect(result.lines).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      kind: "unit_mismatch",
      rowNumber: expect.any(Number),
    });
    expect(result.errors[0]?.message).toContain("KG");
    expect(result.errors[0]?.message).toContain("buc");
    expect(result.canApply).toBe(false);
  });

  it("m2 față de m3 și ml față de mp sunt unități diferite", () => {
    expect(withUnit("M3", "mp").errors.map((e) => e.kind)).toEqual(["unit_mismatch"]);
    expect(withUnit("ML", "mp").errors.map((e) => e.kind)).toEqual(["unit_mismatch"]);
  });

  it("unitate necunoscută: eroare; aceeași scriere ca a variantei declarate: trece", () => {
    const unknown = withUnit("palet", "buc");
    expect(unknown.errors.map((e) => e.kind)).toEqual(["unit_unknown"]);
    expect(withUnit("Palet", "palet").lines).toHaveLength(1);
  });

  it("unitate lipsă pe rând: eroare; variantă fără unitate SmartBill cunoscută: eroare", () => {
    expect(withUnit(null, "buc").errors.map((e) => e.kind)).toEqual(["unit_missing"]);
    expect(withUnit("   ", "buc").errors.map((e) => e.kind)).toEqual(["unit_missing"]);
    expect(withUnit("BUC", null).errors.map((e) => e.kind)).toEqual(["expected_unit_missing"]);
  });

  it("servicii (curs, xpp, turn) se ignoră cu contor, chiar dacă codul există în catalog", () => {
    const result = plan(
      [
        row({ code: "S1", quantity: 10, unit: "CURS" }),
        row({ code: "S2", quantity: 10, unit: "XPP" }),
        row({ code: "S3", quantity: 10, unit: "TURN" }),
        row({ code: "A1", quantity: 1 }),
      ],
      [variant("A1"), variant("S1")],
    );
    expect(result.counters.services).toBe(3);
    expect(result.lines.map((l) => l.sku)).toEqual(["A1"]);
    expect(result.unknownCodes).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("conversia SmartBill → unitatea noastră", () => {
  it("«steps»: 1 bucată SmartBill = 1 pas (2 role × 41,25 mp = 82,5 mp)", () => {
    const result = plan(
      [row({ code: "L1", quantity: 2, unit: "ROLA" })],
      [variant("L1", { expectedUnit: "rola", conversion: { mode: "steps", step: q("41,25") } })],
    );
    expect(fmt(result.lines[0]!.quantity)).toBe("82,5");
    expect(fmt(result.lines[0]!.fileQuantity)).toBe("2");
    expect(result.lines[0]!.warnings).toEqual([]);
  });

  it("«ratio»: 1 sac SmartBill = 25 kg", () => {
    const result = plan(
      [row({ code: "B1", quantity: 3, unit: "SAC" })],
      [variant("B1", { expectedUnit: "sac", conversion: { mode: "ratio", ratio: q("25") } })],
    );
    expect(fmt(result.lines[0]!.quantity)).toBe("75");
  });

  it("conversie cu pierdere: în jos + avertisment (2,3333 role × 41,25 = 96,2486)", () => {
    const result = plan(
      [row({ code: "L1", quantity: "2,3333", unit: "ROLA" })],
      [variant("L1", { expectedUnit: "rola", conversion: { mode: "steps", step: q("41,25") } })],
    );
    expect(fmt(result.lines[0]!.quantity)).toBe("96,2486");
    expect(result.lines[0]!.warnings).toEqual(["converted_rounded_down"]);
    expect(result.warnings.map((w) => w.kind)).toEqual(["converted_rounded_down"]);
    expect(result.canApply).toBe(true);
  });

  it("depășirea plafonului după conversie: eroare", () => {
    const result = plan(
      [row({ code: "L1", quantity: "90000000", unit: "ROLA" })],
      [variant("L1", { expectedUnit: "rola", conversion: { mode: "ratio", ratio: q("50") } })],
    );
    expect(result.errors.map((e) => e.kind)).toEqual(["quantity_overflow"]);
  });
});

describe("variante negestionate, lipsă din fișier și diferențe", () => {
  it("variantă negestionată în fișier: nu se aplică și nu se pornește gestionarea", () => {
    const result = plan(
      [row({ code: "N1", quantity: 6 }), row({ code: "A1", quantity: 1 })],
      [variant("N1", { manageStock: false }), variant("A1")],
    );
    expect(result.lines.map((l) => l.sku)).toEqual(["A1"]);
    expect(result.unmanaged).toEqual([
      expect.objectContaining({ sku: "N1", variantId: "var-N1", rowNumber: expect.any(Number) }),
    ]);
    expect(result.counters.unmanaged).toBe(1);
    expect(result.canApply).toBe(true);
  });

  it("variantă negestionată: unitatea nu se mai verifică (nu se aplică nimic)", () => {
    const result = plan(
      [row({ code: "N1", quantity: 6, unit: "KG" })],
      [variant("N1", { manageStock: false, expectedUnit: "buc" })],
    );
    expect(result.errors).toEqual([]);
    expect(result.unmanaged).toHaveLength(1);
  });

  it("variantă gestionată absentă din fișier: listă separată; cele negestionate nu apar acolo", () => {
    const result = plan(
      [row({ code: "A1", quantity: 1 })],
      [
        variant("A1"),
        variant("A2", { currentPhysical: q("4") }),
        variant("N1", { manageStock: false }),
      ],
    );
    expect(result.missingManaged).toEqual([
      expect.objectContaining({ sku: "A2", variantId: "var-A2" }),
    ]);
    expect(fmt(result.missingManaged[0]!.currentPhysical!)).toBe("4");
    // lipsa NU blochează și NU schimbă nimic: nu există linie pentru A2
    expect(result.lines.map((l) => l.sku)).toEqual(["A1"]);
    expect(result.canApply).toBe(true);
  });

  it("diferența față de stocul curent: cu semn; stoc nepus încă = de la 0", () => {
    const result = plan(
      [row({ code: "A1", quantity: 10 }), row({ code: "A2", quantity: 2 })],
      [variant("A1", { currentPhysical: q("12,5") }), variant("A2", { currentPhysical: null })],
    );
    const a1 = result.lines.find((l) => l.sku === "A1")!;
    const a2 = result.lines.find((l) => l.sku === "A2")!;
    expect(a1.difference).toBe(-25000n);
    expect(a1.current).not.toBeNull();
    expect(a2.current).toBeNull();
    expect(a2.difference).toBe(20000n);
    expect(result.counters.changed).toBe(2);
  });

  it("neschimbat: contorizat separat", () => {
    const result = plan(
      [row({ code: "A1", quantity: 5 })],
      [variant("A1", { currentPhysical: q("5") })],
    );
    expect(result.lines[0]!.difference).toBe(0n);
    expect(result.counters.changed).toBe(0);
    expect(result.counters.unchanged).toBe(1);
  });
});

describe("rezultatul: toate sau deloc, fără scurgeri", () => {
  it("o singură eroare de rând blochează aplicarea; erorile vin în ordinea rândurilor", () => {
    const result = plan(
      [
        row({ code: "A1", quantity: 1, rowNumber: 30 }),
        row({ code: "A2", quantity: "x", rowNumber: 20 }),
        row({ code: "A3", quantity: 1, unit: "KG", rowNumber: 25 }),
      ],
      [variant("A1"), variant("A2"), variant("A3")],
    );
    expect(result.canApply).toBe(false);
    expect(result.errors.map((e) => e.rowNumber)).toEqual([20, 25]);
  });

  it("erorile apar în ordinea rândurilor din fișier, inclusiv «cod lipsă» de la sfârșit", () => {
    const result = plan(
      [
        row({ code: "A1", quantity: "x", rowNumber: 10 }),
        row({ code: null, quantity: 1, rowNumber: 40 }),
        row({ code: "A2", quantity: "y", rowNumber: 25 }),
      ],
      [variant("A1"), variant("A2")],
    );
    expect(result.errors.map((e) => e.rowNumber)).toEqual([10, 25, 40]);
  });

  it("nu poartă «Sold final» sau alte câmpuri necerute: rândul de intrare nu le are, iar linia conține doar câmpurile planului", () => {
    const withExtras = {
      ...row({ code: "A1", quantity: 1 }),
      balance: 123456,
      product: "Denumire",
    } as StockReportRow;
    const result = plan([withExtras], [variant("A1")]);
    const text = JSON.stringify(result, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(text).not.toContain("123456");
    expect(text).not.toContain("Denumire");
  });

  it("totalurile: contoarele se potrivesc cu listele", () => {
    const result = plan(
      [
        row({ code: "A1", quantity: 1 }),
        row({ code: "ZZZ", quantity: 1 }),
        row({ code: "N1", quantity: 1 }),
        row({ code: "S1", quantity: 1, unit: "CURS" }),
        row({ code: "A9", quantity: 1, warehouse: "Alta" }),
      ],
      [variant("A1"), variant("N1", { manageStock: false }), variant("A2")],
    );
    expect(result.counters).toMatchObject({
      rows: 5,
      otherWarehouses: 1,
      services: 1,
      matched: 1,
      unknown: 1,
      unmanaged: 1,
      missing: 1,
    });
  });
});
