import { describe, expect, it } from "vitest";
import { readStockReportFile } from "@ecom/integrations";
import { formatQuantity, parseQuantity, type Quantity } from "@ecom/shared";
import {
  buildReport,
  type FabricatedRow,
  type ReportFormat,
} from "../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { planStockReport, type StockReportVariant } from "./stock-report-plan";

/**
 * Contractul dintre cititorul de fișier (`@ecom/integrations`) și planul importului (`stock-report-plan.ts`): ce iese din
 * cititor intră direct în plan, fără adaptări, pe fișiere .xls și .xlsx FABRICATE (rânduri inventate).
 */

const WAREHOUSE = "Depozit Test";

const rows: FabricatedRow[] = [
  { warehouse: WAREHOUSE, code: "00123", unit: "BUC", quantity: 12 },
  { warehouse: WAREHOUSE, code: "A-9", unit: "KG", quantity: 2.348 },
  { warehouse: WAREHOUSE, code: "00456", unit: "Curs", quantity: 1 },
  { warehouse: "Alt depozit", code: "00123", unit: "BUC", quantity: 99 },
  { warehouse: WAREHOUSE, code: "NECUNOSCUT", unit: "BUC", quantity: 3 },
  { warehouse: WAREHOUSE, code: "B-1", unit: "MP", quantity: 0.30000000000000004 },
];

const variant = (sku: string, expectedUnit: string): StockReportVariant => ({
  variantId: `var-${sku}`,
  sku,
  label: `Produs ${sku}`,
  manageStock: true,
  expectedUnit,
  conversion: { mode: "same_unit" },
  currentPhysical: null,
});

const variants = [variant("00123", "buc"), variant("A-9", "kg"), variant("B-1", "mp")];

describe.each<ReportFormat>(["xls", "xlsx"])("cititor → plan (%s)", (format) => {
  it("rândurile cititorului intră direct în plan", async () => {
    const file = await readStockReportFile(buildReport({ format, rows }));
    const plan = planStockReport({ rows: file.rows, warehouses: [WAREHOUSE], variants });

    expect(plan.counters.rows).toBe(6);
    expect(plan.counters.otherWarehouses).toBe(1);
    expect(plan.counters.services).toBe(1);
    expect(plan.unknownCodes).toEqual([{ rowNumber: 15, code: "NECUNOSCUT" }]);
    const byCode = new Map(plan.lines.map((line) => [line.sku, line]));
    expect(formatQuantity(byCode.get("00123")?.quantity as Quantity)).toBe(
      formatQuantity(parseQuantity("12")),
    );
    expect(byCode.get("A-9")?.quantity).toBe(parseQuantity("2.348"));
    // zgomotul de virgulă mobilă nu se rotunjește pe tăcute: planul îl raportează ca eroare
    expect(plan.errors.map((issue) => [issue.kind, issue.code])).toEqual([
      ["quantity_decimals", "B-1"],
    ]);
    expect(plan.canApply).toBe(false);
  });

  it("cod cu zerouri în față: se potrivește pe SKU-ul exact, nu pe numărul", async () => {
    const file = await readStockReportFile(
      buildReport({
        format,
        rows: [{ warehouse: WAREHOUSE, code: "00123", unit: "BUC", quantity: 4 }],
      }),
    );
    const plan = planStockReport({
      rows: file.rows,
      warehouses: [WAREHOUSE],
      variants: [variant("123", "buc")],
    });
    expect(plan.lines).toHaveLength(0);
    expect(plan.unknownCodes).toEqual([{ rowNumber: 11, code: "00123" }]);
  });

  it("aceeași citire dă același plan în .xls și .xlsx", async () => {
    const a = await readStockReportFile(buildReport({ format: "xls", rows }));
    const b = await readStockReportFile(buildReport({ format: "xlsx", rows }));
    expect(a.rows).toEqual(b.rows);
    expect(a.fileDate).toEqual(b.fileDate);
  });
});
