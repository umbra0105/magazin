import { describe, expect, it } from "vitest";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { StockError } from "./stock-errors";
import {
  computePlanHash,
  describeSnapshotReport,
  selectImportTargets,
} from "./stock-report-import-rules";
import { planStockReport, type StockReportRow, type StockReportVariant } from "./stock-report-plan";

/**
 * Regulile PURE ale importului «stoc la zi»: amprenta planului (ce a văzut utilizatorul = ce se aplică), țintele aplicării
 * (în ordinea fixă de blocare) și confirmarea explicită «lipsă din fișier → 0». Date inventate.
 */

const q = (text: string): Quantity => parseQuantity(text);
const MAIN = "Gestiune principala";

let rowNo = 0;
const row = (over: Partial<StockReportRow> & { code: string | null }): StockReportRow => {
  rowNo += 1;
  return { rowNumber: 10 + rowNo, warehouse: MAIN, unit: "BUC", quantity: 1, ...over };
};
const variant = (sku: string, over: Partial<StockReportVariant> = {}): StockReportVariant => ({
  variantId: `var-${sku}`,
  sku,
  label: `Produs ${sku}`,
  manageStock: true,
  expectedUnit: "buc",
  conversion: { mode: "same_unit" },
  currentPhysical: null,
  ...over,
});

const plan = (rows: StockReportRow[], variants: StockReportVariant[]) =>
  planStockReport({ rows, warehouses: [MAIN], variants });

const stockCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof StockError) return error.code;
    throw error;
  }
  return "NO_ERROR";
};

const FILE_HASH = "a".repeat(64);

describe("computePlanHash", () => {
  const rows = [row({ code: "A", quantity: 5 }), row({ code: "B", quantity: 2 })];
  const variants = [variant("A"), variant("B"), variant("M", { currentPhysical: q("3") })];
  const hash = (p = plan(rows, variants), file = FILE_HASH, warehouses = [MAIN]) =>
    computePlanHash({ fileHash: file, warehouses, plan: p });

  it("aceleași date dau aceeași amprentă, indiferent de ordinea variantelor din catalog", () => {
    expect(hash()).toBe(hash(plan(rows, [...variants].reverse())));
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o cantitate din fișier schimbă amprenta", () => {
    const other = plan([row({ code: "A", quantity: 6 }), rows[1] as StockReportRow], variants);
    expect(hash(other)).not.toBe(hash());
  });

  it("stocul curent al unei variante potrivite schimbă amprenta (catalogul s-a mișcat după previzualizare)", () => {
    const moved = plan(rows, [
      variant("A", { currentPhysical: q("1") }),
      variant("B"),
      variants[2]!,
    ]);
    expect(hash(moved)).not.toBe(hash());
  });

  it("stocul curent al unei variante lipsă din fișier schimbă amprenta", () => {
    const moved = plan(rows, [
      variant("A"),
      variant("B"),
      variant("M", { currentPhysical: q("4") }),
    ]);
    expect(hash(moved)).not.toBe(hash());
  });

  it("o variantă lipsă în plus schimbă amprenta", () => {
    const more = plan(rows, [...variants, variant("N")]);
    expect(hash(more)).not.toBe(hash());
  });

  it("alt fișier sau alte gestiuni alese schimbă amprenta", () => {
    expect(hash(plan(rows, variants), "b".repeat(64))).not.toBe(hash());
    expect(
      computePlanHash({
        fileHash: FILE_HASH,
        warehouses: [MAIN, "Alta"],
        plan: plan(rows, variants),
      }),
    ).not.toBe(hash());
  });

  it("numele gestiunilor se compară fără deosebire de litere și de ordine", () => {
    const a = computePlanHash({
      fileHash: FILE_HASH,
      warehouses: ["X", "Y"],
      plan: plan(rows, variants),
    });
    const b = computePlanHash({
      fileHash: FILE_HASH,
      warehouses: ["y", "x"],
      plan: plan(rows, variants),
    });
    expect(a).toBe(b);
  });
});

describe("selectImportTargets", () => {
  const rows = [row({ code: "B", quantity: 2 }), row({ code: "A", quantity: 5 })];
  const variants = [
    variant("B"),
    variant("A"),
    variant("M1", { currentPhysical: q("3") }),
    variant("M2", { currentPhysical: null }),
  ];

  it("fără confirmare, doar liniile potrivite, în ordinea fixă a identificatorilor", () => {
    const targets = selectImportTargets(plan(rows, variants));
    expect(targets.map((t) => [t.variantId, t.kind, t.quantity])).toEqual([
      ["var-A", "file", q("5")],
      ["var-B", "file", q("2")],
    ]);
  });

  it("cu confirmarea corectă, variantele lipsă primesc 0, tot în ordine fixă", () => {
    const targets = selectImportTargets(plan(rows, variants), { confirm: true, expectedCount: 2 });
    expect(targets.map((t) => [t.variantId, t.kind, t.quantity])).toEqual([
      ["var-A", "file", q("5")],
      ["var-B", "file", q("2")],
      ["var-M1", "zeroed", 0n],
      ["var-M2", "zeroed", 0n],
    ]);
  });

  it("numărul confirmat trebuie să fie exact cel din plan", () => {
    const p = plan(rows, variants);
    expect(stockCode(() => selectImportTargets(p, { confirm: true, expectedCount: 1 }))).toBe(
      "STOCK_IMPORT_ZERO_COUNT_MISMATCH",
    );
    expect(stockCode(() => selectImportTargets(p, { confirm: true, expectedCount: 3 }))).toBe(
      "STOCK_IMPORT_ZERO_COUNT_MISMATCH",
    );
  });

  it("confirmarea fără bifa explicită nu pune nimic pe 0", () => {
    const p = plan(rows, variants);
    const loose = { confirm: false, expectedCount: 2 } as unknown as {
      confirm: true;
      expectedCount: number;
    };
    expect(stockCode(() => selectImportTargets(p, loose))).toBe("STOCK_IMPORT_ZERO_NOT_CONFIRMED");
  });

  it("un plan cu erori nu se aplică deloc", () => {
    const bad = plan([row({ code: "A", unit: "KG" })], [variant("A")]);
    expect(bad.canApply).toBe(false);
    expect(stockCode(() => selectImportTargets(bad))).toBe("STOCK_IMPORT_PLAN_HAS_ERRORS");
  });
});

describe("describeSnapshotReport", () => {
  it("păstrează doar contoare și tipuri de avertismente, fără coduri sau cantități din fișier", () => {
    const p = plan(
      [row({ code: "A", quantity: "-4" }), row({ code: "NECUNOSCUT" })],
      [variant("A"), variant("M", { currentPhysical: q("3") })],
    );
    const report = describeSnapshotReport({
      plan: p,
      zeroedCount: 1,
      timeWarnings: ["file_date_not_today"],
      fileDate: { year: 2026, month: 10, day: 28 },
    });
    expect(report).toMatchObject({
      version: 1,
      counters: p.counters,
      warehousesRead: [MAIN],
      zeroedMissing: 1,
      timeWarnings: ["file_date_not_today"],
      fileDate: "2026-10-28",
      warningKinds: { negative_set_to_zero: 1 },
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("NECUNOSCUT");
    expect(text).not.toContain("var-A");
  });

  it("data din fișier se scrie cu zerouri în față (aaaa-ll-zz)", () => {
    const p = plan([row({ code: "A" })], [variant("A")]);
    expect(
      describeSnapshotReport({
        plan: p,
        zeroedCount: 0,
        timeWarnings: [],
        fileDate: { year: 2026, month: 3, day: 5 },
      }).fileDate,
    ).toBe("2026-03-05");
  });

  it("fără data din fișier, fileDate este null", () => {
    const p = plan([row({ code: "A" })], [variant("A")]);
    expect(
      describeSnapshotReport({ plan: p, zeroedCount: 0, timeWarnings: [], fileDate: null })
        .fileDate,
    ).toBeNull();
  });
});
