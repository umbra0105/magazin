import { createHash } from "node:crypto";
import type { Quantity } from "@ecom/shared";
import { normalizeUnitText } from "./smartbill-units";
import { StockError } from "./stock-errors";
import type { StockReportPlan, StockReportWarningKind } from "./stock-report-plan";
import type { SnapshotTimeWarningKind } from "./stock-report-time";

/**
 * Regulile PURE ale importului «stoc la zi» (serviciul din `stock-report-import.ts` le folosește; nu ating baza de date):
 * amprenta planului, țintele aplicării și raportul păstrat pe `StockSnapshot`.
 */

/** Comparație pe unități de cod, ca `COLLATE "C"` din blocarea rândurilor de stoc (identificatorii sunt ASCII). */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface PlanHashInput {
  fileHash: string;
  /** Gestiunile alese (setarea), în orice ordine și scriere */
  warehouses: readonly string[];
  plan: StockReportPlan;
}

/**
 * Amprenta a ceea ce a văzut utilizatorul: fișierul, gestiunile alese, liniile de aplicat (cantitatea din fișier, cea
 * convertită și stocul curent) și variantele lipsă (cu stocul lor curent). La aplicare serverul recalculează planul și
 * refuză dacă amprenta diferă: ce s-a aplicat e exact ce s-a previzualizat. Nu depinde de ora curentă.
 */
export function computePlanHash(input: PlanHashInput): string {
  const lines = input.plan.lines
    .map((l) => `L|${l.variantId}|${l.fileQuantity}|${l.quantity}|${l.current ?? "-"}`)
    .sort(byCodeUnits);
  const missing = input.plan.missingManaged
    .map((m) => `M|${m.variantId}|${m.currentPhysical ?? "-"}`)
    .sort(byCodeUnits);
  const warehouses = input.warehouses.map((name) => normalizeUnitText(name)).sort(byCodeUnits);
  const text = [
    `file|${input.fileHash}`,
    `wh|${warehouses.join(",")}`,
    `ok|${input.plan.canApply ? 1 : 0}`,
    ...lines,
    ...missing,
  ].join("\n");
  return createHash("sha256").update(text).digest("hex");
}

export interface ZeroMissingRequest {
  confirm: true;
  /** Câte variante lipsă a văzut utilizatorul în previzualizare */
  expectedCount: number;
}

export interface ImportTarget {
  variantId: string;
  sku: string;
  /** `file` = cantitatea din fișier; `zeroed` = lipsă din fișier, pusă pe 0 cu confirmare */
  kind: "file" | "zeroed";
  quantity: Quantity;
}

/**
 * Ce se aplică, în ordinea fixă a blocării rândurilor de stoc (aceeași ca la rezervare, ca importul să nu producă
 * deadlock cu coșurile). Un plan cu erori nu se aplică deloc. Variantele lipsă din fișier se ating DOAR cu confirmare
 * explicită și cu numărul exact văzut în previzualizare.
 */
export function selectImportTargets(
  plan: StockReportPlan,
  zeroMissing?: ZeroMissingRequest,
): ImportTarget[] {
  if (!plan.canApply) {
    throw new StockError(
      "STOCK_IMPORT_PLAN_HAS_ERRORS",
      "Raportul are erori: corectează fișierul sau catalogul și verifică din nou. Nu s-a aplicat nimic.",
      { errors: plan.counters.errors },
    );
  }
  const targets: ImportTarget[] = plan.lines.map((line) => ({
    variantId: line.variantId,
    sku: line.sku,
    kind: "file",
    quantity: line.quantity,
  }));
  if (zeroMissing) {
    if (zeroMissing.confirm !== true) {
      throw new StockError(
        "STOCK_IMPORT_ZERO_NOT_CONFIRMED",
        "Punerea pe 0 a variantelor lipsă din fișier cere confirmare explicită.",
      );
    }
    if (zeroMissing.expectedCount !== plan.missingManaged.length) {
      throw new StockError(
        "STOCK_IMPORT_ZERO_COUNT_MISMATCH",
        "Numărul variantelor lipsă din fișier s-a schimbat de la previzualizare. Verifică din nou.",
        { expected: zeroMissing.expectedCount, actual: plan.missingManaged.length },
      );
    }
    for (const m of plan.missingManaged) {
      targets.push({
        variantId: m.variantId,
        sku: m.sku,
        kind: "zeroed",
        quantity: 0n as Quantity,
      });
    }
  }
  return targets.sort((a, b) => byCodeUnits(a.variantId, b.variantId));
}

export interface SnapshotReportInput {
  plan: StockReportPlan;
  zeroedCount: number;
  timeWarnings: readonly SnapshotTimeWarningKind[];
  fileDate: { year: number; month: number; day: number } | null;
}

export interface SnapshotReport {
  version: 1;
  counters: StockReportPlan["counters"];
  warehousesRead: string[];
  zeroedMissing: number;
  timeWarnings: SnapshotTimeWarningKind[];
  fileDate: string | null;
  warningKinds: Partial<Record<StockReportWarningKind, number>>;
}

const pad = (value: number, length: number): string => String(value).padStart(length, "0");

/**
 * Raportul păstrat pe `StockSnapshot.report` (istoricul pozelor): doar contoare și tipuri de avertismente. Nu conține
 * coduri, denumiri sau cantități din fișier.
 */
export function describeSnapshotReport(input: SnapshotReportInput): SnapshotReport {
  const warningKinds: Partial<Record<StockReportWarningKind, number>> = {};
  for (const warning of input.plan.warnings) {
    warningKinds[warning.kind] = (warningKinds[warning.kind] ?? 0) + 1;
  }
  return {
    version: 1,
    counters: input.plan.counters,
    warehousesRead: [...input.plan.warehousesRead],
    zeroedMissing: input.zeroedCount,
    timeWarnings: [...input.timeWarnings],
    fileDate: input.fileDate
      ? `${pad(input.fileDate.year, 4)}-${pad(input.fileDate.month, 2)}-${pad(input.fileDate.day, 2)}`
      : null,
    warningKinds,
  };
}
