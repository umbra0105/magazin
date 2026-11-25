import { classifySmartbillUnit, normalizeUnitText } from "../../inventory/smartbill-units";
import {
  costToMinor,
  isPositive,
  parseDecimalText,
  parseNirDate,
  type CalendarDate,
  type DecimalText,
  type NirRawRow,
} from "./nir-parse";

/**
 * Planul importului prețurilor de achiziție (NIR, Faza 15), PUR: din rândurile fișierului și variantele catalogului scoate ce se
 * va actualiza și raportul. Regulile (decizii 2026-11-24, nu se rediscută):
 *  - contează doar rândurile cu «Intrari» > 0; cantitățile zero sau negative (storno, ieșiri) se ignorează și se numără;
 *  - codul = SKU-ul variantei, potrivire exactă după `trim`; altfel, fără diferență de majuscule, DOAR dacă duce la o singură
 *    variantă; altfel cod necunoscut (nu se ghicește);
 *  - «Cost unitar» = cost NET (fără TVA), rotunjit O SINGURĂ DATĂ, half-up, la bani; 0, negativ sau nenumeric = rând invalid;
 *  - pe același cod câștigă data cea mai recentă; la aceeași dată, ultimul rând din fișier (intrările multiple din aceeași zi se
 *    raportează ca informație);
 *  - unitate diferită (varianta ținută în SmartBill pe pași sau cu raport, prețul variantei pe pas, sau unitatea din fișier nu e a
 *    variantei): rândul se SARE și se raportează; nu se ghicește nicio conversie;
 *  - actualizarea reală (cu «doar dacă data e STRICT mai nouă») o face depozitul, atomic; aici se estimează după datele curente.
 *
 * ⚠️ Rapoartele conțin costuri (vizibile doar cu `products.cost.view`); mesajele de motiv nu repetă valori din fișier.
 */

export interface NirVariant {
  variantId: string;
  sku: string;
  /** Data intrării curente (`costPriceDate`), ca zi calendaristică `aaaa-ll-zz`; `null` = fără preț NIR. */
  currentDate: string | null;
  /** Cum ține SmartBill stocul: doar «same_unit» e sigur pentru cost. */
  smartbillMode: "same_unit" | "steps" | "ratio";
  /** Prețul variantei e pe unitate (`unit`) sau pe pas (`step`). */
  priceBasis: "unit" | "step";
  /** Unitatea variantei în SmartBill (numele din setarea variantei sau al unității de măsură). */
  expectedUnit: string;
}

export interface NirCatalog {
  /** Potrivire exactă după `trim` (SKU-urile se compară ca text). */
  exact(code: string): NirVariant | undefined;
  /** Variantele al căror SKU diferă de cod doar prin majuscule/minuscule. */
  caseInsensitive(code: string): readonly NirVariant[];
}

export interface NirIssueRow {
  row: number;
  code: string | null;
  reason: string;
}

export interface NirUnitRow extends NirIssueRow {
  fileUnit: string | null;
}

export interface NirResultRow {
  row: number;
  code: string;
  /** `aaaa-ll-zz` */
  date: string;
  /** Costul net, în bani. Doar pentru cei care au `products.cost.view`. */
  costMinor: number;
}

export interface NirCounters {
  /** Rândurile de date din fișier (fără goale și fără «Total»). */
  fileRows: number;
  blankRows: number;
  totalRows: number;
  /** Rânduri fără intrare (cantitate zero, negativă sau lipsă). */
  ignored: number;
  invalid: number;
  unknownCodes: number;
  unitDifferent: number;
  /** Coduri (variante) cu cel puțin o intrare bună. */
  matchedCodes: number;
  /** Se vor actualiza (după datele din momentul planului). */
  updated: number;
  /** Data nu e mai nouă decât cea curentă. */
  unchanged: number;
  /** Coduri cu mai multe intrări în aceeași zi. */
  multiSameDay: number;
}

export interface NirReport {
  counters: NirCounters;
  invalid: NirIssueRow[];
  unknown: NirIssueRow[];
  unitDifferent: NirUnitRow[];
  updated: NirResultRow[];
  unchanged: NirResultRow[];
  multiSameDay: Array<{ code: string; date: string; rows: number[] }>;
  /** Tipurile de document ≠ «recepție» pe rânduri cu intrare, ca informație. */
  otherDocTypes: Array<{ type: string; count: number }>;
}

export interface NirPlanItem {
  variantId: string;
  code: string;
  row: number;
  date: string;
  costMinor: number;
}

export interface NirPlan {
  /** Ce se aplică: câștigătorul fiecărui cod, doar dacă data lui e mai nouă decât cea curentă. */
  items: NirPlanItem[];
  report: NirReport;
}

export interface PlanNirInput {
  rows: readonly NirRawRow[];
  counters: { blankRows: number; totalRows: number };
  catalog: NirCatalog;
  now: Date;
}

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const RECEIPT_TYPES = new Set(["receptie", "receptii", "receptie marfa", "nir"]);

const isBlank = (text: string | null): boolean => text === null || text.trim() === "";

/** Unitatea din fișier se potrivește cu a variantei? Aceeași logică ca la importul «Stoc la zi»: tabelul explicit, nu ghicire. */
export function unitMatches(fileUnit: string, expectedUnit: string): boolean {
  const file = classifySmartbillUnit(fileUnit);
  const expected = classifySmartbillUnit(expectedUnit);
  if (file.kind === "unit" && expected.kind === "unit") return file.key === expected.key;
  // o unitate din afara tabelului se acceptă doar scrisă la fel ca cea declarată pe variantă
  return normalizeUnitText(fileUnit) === normalizeUnitText(expectedUnit);
}

interface Entry {
  row: number;
  code: string;
  variant: NirVariant;
  date: CalendarDate;
  costMinor: number;
}

export function planNirImport(input: PlanNirInput): NirPlan {
  const invalid: NirIssueRow[] = [];
  const unknown: NirIssueRow[] = [];
  const unitDifferent: NirUnitRow[] = [];
  const entries: Entry[] = [];
  const docTypes = new Map<string, number>();
  let ignored = 0;

  for (const row of input.rows) {
    // 1. intrare? doar cantitatea > 0 contează
    let quantity: DecimalText | null = null;
    if (!isBlank(row.qtyIn)) {
      quantity = parseDecimalText(row.qtyIn);
      if (quantity === null) {
        invalid.push({
          row: row.rowNumber,
          code: row.code,
          reason: "cantitatea intrată nu e un număr",
        });
        continue;
      }
    }
    if (quantity === null || !isPositive(quantity)) {
      ignored += 1;
      continue;
    }

    // 2. rând de intrare: câmpurile trebuie să fie valide
    const code = row.code?.trim() ?? "";
    if (code === "") {
      invalid.push({ row: row.rowNumber, code: null, reason: "lipsește codul" });
      continue;
    }
    const date = parseNirDate(row.date);
    if (date === null) {
      invalid.push({
        row: row.rowNumber,
        code,
        reason: "data nu e validă (se așteaptă zz/ll/aaaa, o zi care există)",
      });
      continue;
    }
    if (Date.UTC(date.year, date.month - 1, date.day) > input.now.getTime() + FUTURE_TOLERANCE_MS) {
      invalid.push({ row: row.rowNumber, code, reason: "data intrării e în viitor" });
      continue;
    }
    const cost = parseDecimalText(row.unitCost);
    if (cost === null) {
      invalid.push({
        row: row.rowNumber,
        code,
        reason: "costul unitar lipsește sau nu e un număr",
      });
      continue;
    }
    const costMinor = costToMinor(cost);
    if (costMinor === null) {
      invalid.push({ row: row.rowNumber, code, reason: "preț prea mic sau invalid" });
      continue;
    }

    // tipul documentului: ca informație, când nu e recepție
    const type = row.docType?.trim() ?? "";
    if (type !== "" && !RECEIPT_TYPES.has(normalizeUnitText(type))) {
      docTypes.set(type, (docTypes.get(type) ?? 0) + 1);
    }

    // 3. potrivirea codului: exactă, apoi fără diferență de majuscule doar dacă e unică
    let variant: NirVariant | undefined = input.catalog.exact(code);
    if (variant === undefined) {
      const near = input.catalog.caseInsensitive(code);
      if (near.length === 1) variant = near[0];
      else if (near.length > 1) {
        unknown.push({
          row: row.rowNumber,
          code,
          reason: "cod ambiguu: mai multe variante diferă doar prin majuscule",
        });
        continue;
      }
    }
    if (variant === undefined) {
      unknown.push({ row: row.rowNumber, code, reason: "cod necunoscut" });
      continue;
    }

    // 4. unitatea: nicio conversie ghicită
    if (variant.smartbillMode !== "same_unit") {
      unitDifferent.push({
        row: row.rowNumber,
        code,
        fileUnit: row.unit,
        reason:
          "varianta e ținută în SmartBill pe pași sau cu raport de conversie: de verificat manual",
      });
      continue;
    }
    if (variant.priceBasis !== "unit") {
      unitDifferent.push({
        row: row.rowNumber,
        code,
        fileUnit: row.unit,
        reason:
          "prețul variantei e pe pas, iar costul din fișier e pe unitatea SmartBill: de verificat manual",
      });
      continue;
    }
    if (isBlank(row.unit)) {
      unitDifferent.push({
        row: row.rowNumber,
        code,
        fileUnit: null,
        reason: "lipsește unitatea de măsură din fișier: de verificat manual",
      });
      continue;
    }
    if (!unitMatches(row.unit as string, variant.expectedUnit)) {
      unitDifferent.push({
        row: row.rowNumber,
        code,
        fileUnit: row.unit,
        reason: "unitatea din fișier diferă de a variantei: de verificat manual",
      });
      continue;
    }
    entries.push({ row: row.rowNumber, code, variant, date, costMinor });
  }

  // 5. pe fiecare variantă câștigă data cea mai recentă; la aceeași dată, ultimul rând din fișier
  const byVariant = new Map<string, Entry[]>();
  for (const entry of entries) {
    byVariant.set(entry.variant.variantId, [
      ...(byVariant.get(entry.variant.variantId) ?? []),
      entry,
    ]);
  }
  const items: NirPlanItem[] = [];
  const updated: NirResultRow[] = [];
  const unchanged: NirResultRow[] = [];
  const multiSameDay: NirReport["multiSameDay"] = [];
  for (const group of byVariant.values()) {
    const sorted = [...group].sort((a, b) =>
      a.date.iso < b.date.iso ? 1 : a.date.iso > b.date.iso ? -1 : b.row - a.row,
    );
    const winner = sorted[0] as Entry;
    const sameDay = group.filter((entry) => entry.date.iso === winner.date.iso);
    if (sameDay.length > 1) {
      multiSameDay.push({
        code: winner.variant.sku,
        date: winner.date.iso,
        rows: sameDay.map((entry) => entry.row).sort((a, b) => a - b),
      });
    }
    const result: NirResultRow = {
      row: winner.row,
      code: winner.variant.sku,
      date: winner.date.iso,
      costMinor: winner.costMinor,
    };
    const current = winner.variant.currentDate;
    if (current === null || winner.date.iso > current) {
      items.push({
        variantId: winner.variant.variantId,
        code: winner.variant.sku,
        row: winner.row,
        date: winner.date.iso,
        costMinor: winner.costMinor,
      });
      updated.push(result);
    } else {
      unchanged.push(result);
    }
  }
  const byRow = <T extends { row: number }>(a: T, b: T) => a.row - b.row;
  items.sort((a, b) => a.row - b.row);
  updated.sort(byRow);
  unchanged.sort(byRow);
  multiSameDay.sort((a, b) => (a.rows[0] ?? 0) - (b.rows[0] ?? 0));

  return {
    items,
    report: {
      counters: {
        fileRows: input.rows.length,
        blankRows: input.counters.blankRows,
        totalRows: input.counters.totalRows,
        ignored,
        invalid: invalid.length,
        unknownCodes: unknown.length,
        unitDifferent: unitDifferent.length,
        matchedCodes: byVariant.size,
        updated: updated.length,
        unchanged: unchanged.length,
        multiSameDay: multiSameDay.length,
      },
      invalid,
      unknown,
      unitDifferent,
      updated,
      unchanged,
      multiSameDay,
      otherDocTypes: [...docTypes.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => a.type.localeCompare(b.type, "ro")),
    },
  };
}
