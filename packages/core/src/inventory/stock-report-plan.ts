import {
  QuantityError,
  deltaBetween,
  multiplyByFactor,
  parseQuantity,
  type Quantity,
  type QuantityDelta,
} from "@ecom/shared";
import { classifySmartbillUnit, normalizeUnitText } from "./smartbill-units";
import { StockError } from "./stock-errors";

/**
 * Planul importului «stoc la zi» din raportul SmartBill: din rândurile fișierului (deja citite de adaptor) și din
 * variantele catalogului, produce raportul de verificare. Funcție PURĂ: nu citește fișiere, nu atinge baza de date și nu
 * modifică nimic; aplicarea (toată sau deloc) este a serviciului.
 *
 * Reguli (decise de utilizator):
 * - se citesc DOAR gestiunile alese în setarea `inventory.smartbillWarehouses` (nu stau în cod); celelalte se ignoră cu contor;
 * - cantitățile se citesc EXACT (fără `float`), cel mult 4 zecimale (mai multe = eroare); cele cu 3 se păstrează;
 * - unitatea din fișier se normalizează prin tabel (`smartbill-units.ts`) și trebuie să fie cea a variantei în SmartBill;
 * - cod duplicat în gestiunile alese = eroare; cod necunoscut = listat, nu se creează produse; variantă gestionată absentă
 *   din fișier = listă separată, NEMODIFICATĂ aici (punerea ei pe 0 cere confirmare explicită, în serviciu);
 * - servicii și rânduri fără cantitate = ignorate cu contor; varianta negestionată nu se aplică și nu i se pornește
 *   gestionarea (inventarul îl face utilizatorul);
 * - orice eroare de rând blochează aplicarea (`canApply = false`): poza se aplică toată sau deloc.
 * Coloanele care nu sunt cerute (denumire, «Sold final» = valoare la cost, stoc minim) nu intră în plan și nu se stochează.
 */

export interface StockReportRow {
  /** Numărul rândului în fișier (pentru mesaje) */
  rowNumber: number;
  warehouse: string | null;
  code: string | null;
  unit: string | null;
  /** Număr din `.xls` sau text; `null` = celulă goală */
  quantity: string | number | null;
}

export type StockReportConversion =
  | { mode: "same_unit" }
  /** 1 bucată SmartBill = 1 pas; `step` = pasul variantei */
  | { mode: "steps"; step: Quantity }
  /** 1 unitate SmartBill = `ratio` din unitatea noastră */
  | { mode: "ratio"; ratio: Quantity };

export interface StockReportVariant {
  variantId: string;
  sku: string;
  /** Titlul produsului (și varianta), pentru raport */
  label: string;
  manageStock: boolean;
  /**
   * Cum se numește unitatea variantei în SmartBill, rezolvată de apelant: «Unitatea SmartBill» a variantei, altfel cea a
   * unității de măsură, altfel codul ei. `null` = nu se știe (eroare de configurare, nu se ghicește).
   */
  expectedUnit: string | null;
  conversion: StockReportConversion;
  currentPhysical: Quantity | null;
}

export type StockReportIssueKind =
  | "missing_code"
  | "duplicate_code"
  | "unit_missing"
  | "unit_unknown"
  | "unit_mismatch"
  | "expected_unit_missing"
  | "quantity_invalid"
  | "quantity_decimals"
  | "quantity_overflow";

export type StockReportWarningKind = "negative_set_to_zero" | "converted_rounded_down";

export interface StockReportIssue {
  kind: StockReportIssueKind;
  rowNumber: number;
  code: string | null;
  message: string;
}

export interface StockReportWarning {
  kind: StockReportWarningKind;
  rowNumber: number;
  code: string;
  message: string;
}

export interface StockReportLine {
  rowNumber: number;
  variantId: string;
  sku: string;
  label: string;
  /** Cantitatea din fișier, în unitatea SmartBill */
  fileQuantity: Quantity;
  /** Cantitatea de aplicat, în unitatea variantei, după conversie */
  quantity: Quantity;
  current: Quantity | null;
  /** `quantity` − (`current` sau 0) */
  difference: QuantityDelta;
  warnings: StockReportWarningKind[];
}

export interface StockReportCounters {
  /** Rândurile de date din fișier */
  rows: number;
  otherWarehouses: number;
  services: number;
  withoutQuantity: number;
  matched: number;
  changed: number;
  unchanged: number;
  unknown: number;
  unmanaged: number;
  missing: number;
  errors: number;
  warnings: number;
}

export interface StockReportPlan {
  /** Gestiunile citite, așa cum apar în fișier */
  warehousesRead: string[];
  counters: StockReportCounters;
  lines: StockReportLine[];
  errors: StockReportIssue[];
  warnings: StockReportWarning[];
  unknownCodes: Array<{ rowNumber: number; code: string }>;
  unmanaged: Array<{ rowNumber: number; variantId: string; sku: string; label: string }>;
  missingManaged: Array<{
    variantId: string;
    sku: string;
    label: string;
    currentPhysical: Quantity | null;
  }>;
  canApply: boolean;
}

export interface PlanStockReportInput {
  rows: readonly StockReportRow[];
  /** Numele gestiunilor alese (setarea `inventory.smartbillWarehouses`) */
  warehouses: readonly string[];
  variants: readonly StockReportVariant[];
}

/** Gestiunea se potrivește fără deosebire de litere, diacritice și spații în plus. */
const warehouseKey = (name: string | null | undefined): string => normalizeUnitText(name);

const MAX_QUANTITY_DECIMALS = 4;

type ParsedQuantity =
  | { ok: true; quantity: Quantity; negative: boolean }
  | { ok: false; kind: "quantity_invalid" | "quantity_decimals" | "quantity_overflow" };

/** Numărul din `.xls` devine text zecimal scurt; notația științifică și valorile nefinite sunt ilizibile. */
function quantityText(value: string | number): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
  }
  return value.trim();
}

function parseFileQuantity(value: string | number): ParsedQuantity {
  const text = quantityText(value);
  if (text === null) return { ok: false, kind: "quantity_invalid" };
  const negative = /^-\s*\d/.test(text) && !/^-0+([.,]0*)?$/.test(text);
  const unsigned = /^-/.test(text) ? text.slice(1).trim() : text;
  try {
    const quantity = parseQuantity(unsigned, { maxDecimals: MAX_QUANTITY_DECIMALS });
    return { ok: true, quantity: negative ? (0n as Quantity) : quantity, negative };
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    if (error.reason === "too_many_decimals") return { ok: false, kind: "quantity_decimals" };
    if (error.reason === "overflow") return { ok: false, kind: "quantity_overflow" };
    return { ok: false, kind: "quantity_invalid" };
  }
}

const isBlank = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === "";

const showUnit = (unit: string): string => unit.trim();

function fatal(code: string, message: string): never {
  throw new StockError(code, message);
}

export function planStockReport(input: PlanStockReportInput): StockReportPlan {
  const chosen = input.warehouses.filter((name) => warehouseKey(name) !== "");
  if (chosen.length === 0) {
    fatal(
      "STOCK_REPORT_NO_WAREHOUSE",
      "Nu este aleasă nicio gestiune SmartBill. Setează în Setări gestiunea din care se citește stocul.",
    );
  }
  if (input.rows.length === 0) {
    fatal("STOCK_REPORT_EMPTY", "Fișierul nu conține niciun rând de date.");
  }

  const chosenKeys = new Set(chosen.map(warehouseKey));
  const foundKeys = new Set(
    input.rows.map((row) => warehouseKey(row.warehouse)).filter((key) => key !== ""),
  );
  const missingWarehouses = chosen.filter((name) => !foundKeys.has(warehouseKey(name)));
  if (missingWarehouses.length > 0) {
    const available = [
      ...new Set(
        input.rows.map((row) => (row.warehouse ?? "").trim()).filter((name) => name !== ""),
      ),
    ];
    fatal(
      "STOCK_REPORT_WAREHOUSE_NOT_FOUND",
      `Gestiunea «${missingWarehouses.join("», «")}» nu apare în fișier. Gestiuni găsite în fișier: ${
        available.length > 0 ? available.map((name) => `«${name}»`).join(", ") : "niciuna"
      }.`,
    );
  }

  const bySku = new Map<string, StockReportVariant>();
  for (const variant of input.variants) bySku.set(variant.sku, variant);

  const counters: StockReportCounters = {
    rows: input.rows.length,
    otherWarehouses: 0,
    services: 0,
    withoutQuantity: 0,
    matched: 0,
    changed: 0,
    unchanged: 0,
    unknown: 0,
    unmanaged: 0,
    missing: 0,
    errors: 0,
    warnings: 0,
  };
  const errors: StockReportIssue[] = [];
  const warnings: StockReportWarning[] = [];
  const lines: StockReportLine[] = [];
  const unknownCodes: StockReportPlan["unknownCodes"] = [];
  const unmanaged: StockReportPlan["unmanaged"] = [];
  const warehousesRead = new Map<string, string>();

  // 1. rândurile gestiunilor alese, fără serviciile și rândurile fără cantitate
  const relevant: Array<{ row: StockReportRow; code: string }> = [];
  const noCode: StockReportRow[] = [];
  for (const row of input.rows) {
    const key = warehouseKey(row.warehouse);
    if (!chosenKeys.has(key)) {
      counters.otherWarehouses += 1;
      continue;
    }
    if (!warehousesRead.has(key)) warehousesRead.set(key, (row.warehouse ?? "").trim());
    const blankQuantity =
      row.quantity === null || (typeof row.quantity === "string" && row.quantity.trim() === "");
    if (blankQuantity) {
      counters.withoutQuantity += 1;
      continue;
    }
    if (classifySmartbillUnit(row.unit).kind === "service") {
      counters.services += 1;
      continue;
    }
    const code = (row.code ?? "").trim();
    if (code === "") noCode.push(row);
    else relevant.push({ row, code });
  }
  for (const row of noCode) {
    errors.push({
      kind: "missing_code",
      rowNumber: row.rowNumber,
      code: null,
      message: `Rândul ${row.rowNumber}: lipsește codul produsului.`,
    });
  }

  // 2. duplicate în gestiunile alese: eroare pe fiecare rând, nimic nu se însumează
  const byCode = new Map<string, number[]>();
  for (const { row, code } of relevant) {
    byCode.set(code, [...(byCode.get(code) ?? []), row.rowNumber]);
  }
  const duplicated = new Set<string>();
  for (const [code, rowNumbers] of byCode) {
    if (rowNumbers.length < 2) continue;
    duplicated.add(code);
    for (const rowNumber of rowNumbers) {
      errors.push({
        kind: "duplicate_code",
        rowNumber,
        code,
        message: `Rândul ${rowNumber}: codul «${code}» apare de ${rowNumbers.length} ori în gestiunea aleasă (rândurile ${rowNumbers.join(", ")}). Un cod trebuie să aibă un singur rând.`,
      });
    }
  }

  // 3. restul regulilor, pe fiecare rând
  const seen = new Set<string>(duplicated);
  for (const { row, code } of relevant) {
    if (duplicated.has(code)) continue;
    seen.add(code);
    const variant = bySku.get(code);
    if (!variant) {
      unknownCodes.push({ rowNumber: row.rowNumber, code });
      continue;
    }
    if (!variant.manageStock) {
      unmanaged.push({
        rowNumber: row.rowNumber,
        variantId: variant.variantId,
        sku: variant.sku,
        label: variant.label,
      });
      continue;
    }
    const issue = checkUnit(row, code, variant);
    if (issue) {
      errors.push(issue);
      continue;
    }
    const parsed = parseFileQuantity(row.quantity as string | number);
    if (!parsed.ok) {
      errors.push(quantityIssue(parsed.kind, row, code));
      continue;
    }
    let target: Quantity = parsed.quantity;
    const lineWarnings: StockReportWarningKind[] = [];
    if (parsed.negative) {
      lineWarnings.push("negative_set_to_zero");
      warnings.push({
        kind: "negative_set_to_zero",
        rowNumber: row.rowNumber,
        code,
        message: `Rândul ${row.rowNumber}, «${code}»: cantitatea din SmartBill este negativă; se aplică 0.`,
      });
    }
    const factor =
      variant.conversion.mode === "steps"
        ? variant.conversion.step
        : variant.conversion.mode === "ratio"
          ? variant.conversion.ratio
          : null;
    if (factor !== null) {
      try {
        const converted = multiplyByFactor(target, factor);
        target = converted.quantity;
        if (converted.lossy) {
          lineWarnings.push("converted_rounded_down");
          warnings.push({
            kind: "converted_rounded_down",
            rowNumber: row.rowNumber,
            code,
            message: `Rândul ${row.rowNumber}, «${code}»: conversia în unitatea magazinului dă mai mult de 4 zecimale; cantitatea s-a rotunjit în jos.`,
          });
        }
      } catch (error) {
        if (!(error instanceof QuantityError)) throw error;
        errors.push(quantityIssue("quantity_overflow", row, code));
        continue;
      }
    }
    const difference = deltaBetween(variant.currentPhysical ?? (0n as Quantity), target);
    lines.push({
      rowNumber: row.rowNumber,
      variantId: variant.variantId,
      sku: variant.sku,
      label: variant.label,
      fileQuantity: parsed.negative ? (0n as Quantity) : parsed.quantity,
      quantity: target,
      current: variant.currentPhysical,
      difference,
      warnings: lineWarnings,
    });
  }

  // 4. variante gestionate care nu apar în fișier (nici cu eroare)
  const missingManaged = input.variants
    .filter((variant) => variant.manageStock && !seen.has(variant.sku))
    .map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      label: variant.label,
      currentPhysical: variant.currentPhysical,
    }));

  errors.sort((a, b) => a.rowNumber - b.rowNumber);
  counters.matched = lines.length;
  counters.changed = lines.filter((line) => line.difference !== 0n).length;
  counters.unchanged = lines.length - counters.changed;
  counters.unknown = unknownCodes.length;
  counters.unmanaged = unmanaged.length;
  counters.missing = missingManaged.length;
  counters.errors = errors.length;
  counters.warnings = warnings.length;

  return {
    warehousesRead: [...warehousesRead.values()],
    counters,
    lines,
    errors,
    warnings,
    unknownCodes,
    unmanaged,
    missingManaged,
    canApply: errors.length === 0,
  };
}

function checkUnit(
  row: StockReportRow,
  code: string,
  variant: StockReportVariant,
): StockReportIssue | null {
  const at = `Rândul ${row.rowNumber}, «${code}»`;
  if (isBlank(row.unit)) {
    return {
      kind: "unit_missing",
      rowNumber: row.rowNumber,
      code,
      message: `${at}: lipsește unitatea de măsură din fișier.`,
    };
  }
  const fileUnit = showUnit(row.unit as string);
  if (isBlank(variant.expectedUnit)) {
    return {
      kind: "expected_unit_missing",
      rowNumber: row.rowNumber,
      code,
      message: `${at}: varianta nu are o «Unitate SmartBill» cunoscută, deci unitatea din fișier (${fileUnit}) nu se poate verifica. Completeaz-o în editorul produsului.`,
    };
  }
  const expectedUnit = showUnit(variant.expectedUnit as string);
  const file = classifySmartbillUnit(fileUnit);
  const expected = classifySmartbillUnit(expectedUnit);
  if (file.kind === "unit" && expected.kind === "unit") {
    if (file.key === expected.key) return null;
  } else if (normalizeUnitText(fileUnit) === normalizeUnitText(expectedUnit)) {
    // unitate din afara tabelului, scrisă la fel ca cea declarată pe variantă
    return null;
  } else if (file.kind === "unknown") {
    return {
      kind: "unit_unknown",
      rowNumber: row.rowNumber,
      code,
      message: `${at}: unitatea «${fileUnit}» din fișier nu este recunoscută (varianta așteaptă «${expectedUnit}»).`,
    };
  }
  return {
    kind: "unit_mismatch",
    rowNumber: row.rowNumber,
    code,
    message: `${at}: în fișier unitatea este «${fileUnit}», dar varianta este ținută în SmartBill în «${expectedUnit}». Rândul nu se aplică.`,
  };
}

function quantityIssue(
  kind: "quantity_invalid" | "quantity_decimals" | "quantity_overflow",
  row: StockReportRow,
  code: string,
): StockReportIssue {
  const at = `Rândul ${row.rowNumber}, «${code}»`;
  const message =
    kind === "quantity_decimals"
      ? `${at}: cantitatea are mai mult de ${MAX_QUANTITY_DECIMALS} zecimale; nu se rotunjește singură.`
      : kind === "quantity_overflow"
        ? `${at}: cantitatea depășește valoarea maximă acceptată.`
        : `${at}: cantitatea din fișier nu este un număr valid.`;
  return { kind, rowNumber: row.rowNumber, code, message };
}
