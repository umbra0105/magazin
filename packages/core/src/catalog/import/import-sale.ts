import {
  QUANTITY_FACTOR,
  QuantityError,
  parseQuantity,
  saleStepToInt,
  type Quantity,
} from "@ecom/shared";
import { checkSaleConfig } from "../../inventory/sale-config";
import { DEFAULT_MEASURE_UNIT_CODE, INITIAL_MEASURE_UNITS } from "../../inventory/constants";
import { foldText, importField, type ImportFieldKey } from "./import-fields";

/**
 * Coloanele de vânzare ale importului (Faza 5, punctul 9b): unitate de măsură, baza prețului, pas, minim, denumirea pasului,
 * conversia SmartBill, starea stocului și termenul de livrare. Funcții PURE, fără acces la date: citesc textul din celule și îl
 * transformă în valori exacte (pasul și raportul trec doar prin `Quantity`, fără `float`); mesajele sunt în română și numesc
 * câmpul. Decizia «pe produs sau pe variantă» și verificările pe configurația EFECTIVĂ sunt în planificator (vezi mai jos).
 */

/** O unitate de măsură, cât trebuie importului. */
export interface ImportUnit {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  isActive: boolean;
}

export type SmartbillModeValue = "same_unit" | "steps" | "ratio";
export type StockStatusValue = "instock" | "outofstock" | "onbackorder";

/** Valorile citite dintr-un rând: lipsă = celulă goală (neschimbat), `null` = marcajul de ștergere («-»). */
export interface SaleValues {
  /** `id: null` = la bucată (unitatea implicită, salvată ca «fără unitate») */
  unit?: { id: string | null; unit: ImportUnit | null; decimals: number };
  priceBasis?: "unit" | "step";
  saleStep?: number | null;
  minSteps?: number | null;
  saleStepLabel?: string | null;
  smartbillMode?: SmartbillModeValue | null;
  smartbillUnitName?: string | null;
  smartbillRatio?: number | null;
  stockStatus?: StockStatusValue;
  leadTimeDays?: number | null;
}

export interface SaleError {
  field: ImportFieldKey;
  text: string;
}

/**
 * Configurarea de vânzare ACTUALĂ a unei variante și a produsului ei, citită din catalog (valorile proprii, nu cele
 * efective): planificatorul le combină (varianta peste produs peste «buc»).
 */
export interface ExistingSale {
  variant: {
    measureUnitId: string | null;
    priceBasis: string | null;
    saleStep: number | null;
    minSteps: number | null;
    manageStock: boolean | null;
    stockStatus: string | null;
    smartbillMode: string | null;
    smartbillUnitName: string | null;
    smartbillRatio: number | null;
  };
  product: {
    measureUnitId: string | null;
    priceBasis: string;
    saleStep: number | null;
    minSteps: number | null;
    saleStepLabel: string | null;
    leadTimeDays: number | null;
    manageStock: boolean;
    stockStatus: string;
    type: string;
    /** Toate variantele produsului (pentru regula «valoarea uniformă doar dacă fișierul le conține pe toate») */
    variantIds: readonly string[];
  };
}

/** Configurare «goală» (produs la bucată, fără nimic setat, gestionat), pentru teste și pentru instantanee fără vânzare. */
export function emptyExistingSale(variantIds: readonly string[] = []): ExistingSale {
  return {
    variant: {
      measureUnitId: null,
      priceBasis: null,
      saleStep: null,
      minSteps: null,
      manageStock: null,
      stockStatus: null,
      smartbillMode: null,
      smartbillUnitName: null,
      smartbillRatio: null,
    },
    product: {
      measureUnitId: null,
      priceBasis: "unit",
      saleStep: null,
      minSteps: null,
      saleStepLabel: null,
      leadTimeDays: null,
      manageStock: true,
      stockStatus: "instock",
      type: "physical",
      variantIds,
    },
  };
}

export const SALE_FIELD_KEYS = [
  "unit",
  "priceBasis",
  "saleStep",
  "minSteps",
  "saleStepLabel",
  "smartbillMode",
  "smartbillUnitName",
  "smartbillRatio",
  "stockStatus",
  "leadTimeDays",
] as const satisfies readonly ImportFieldKey[];

const shortValue = (raw: string): string => (raw.length > 30 ? `${raw.slice(0, 30)}…` : raw);

const BASIS: Record<string, "unit" | "step"> = {
  "pe unitate": "unit",
  unitate: "unit",
  unit: "unit",
  "pe pas": "step",
  pas: "step",
  step: "step",
};
const MODES: Record<string, SmartbillModeValue> = {
  "aceeasi unitate": "same_unit",
  "same unit": "same_unit",
  same_unit: "same_unit",
  pasi: "steps",
  steps: "steps",
  raport: "ratio",
  ratio: "ratio",
};
const STATUSES: Record<string, StockStatusValue> = {
  "in stoc": "instock",
  instock: "instock",
  "stoc epuizat": "outofstock",
  epuizat: "outofstock",
  outofstock: "outofstock",
  "la comanda": "onbackorder",
  onbackorder: "onbackorder",
};

const DEFAULT_UNIT = INITIAL_MEASURE_UNITS.find((u) => u.code === DEFAULT_MEASURE_UNIT_CODE);
const DEFAULT_UNIT_KEYS = new Set(
  [DEFAULT_MEASURE_UNIT_CODE, DEFAULT_UNIT?.symbol, DEFAULT_UNIT?.name]
    .filter((v): v is string => typeof v === "string")
    .map(foldText),
);

/** Unitatea din textul celulei: simbol, nume sau cod (fără diferență de majuscule sau diacritice). */
function resolveUnit(
  raw: string,
  units: readonly ImportUnit[],
): { ok: true; value: NonNullable<SaleValues["unit"]> } | { ok: false; text: string } {
  const key = foldText(raw);
  if (DEFAULT_UNIT_KEYS.has(key)) return { ok: true, value: { id: null, unit: null, decimals: 0 } };
  const matches = units.filter(
    (u) => foldText(u.symbol) === key || foldText(u.name) === key || foldText(u.code) === key,
  );
  const distinct = [...new Map(matches.map((u) => [u.id, u])).values()];
  if (distinct.length === 0) {
    return {
      ok: false,
      text: `unitatea „${shortValue(raw)}” nu există; creeaz-o mai întâi în Unități de măsură`,
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      text: `mai multe unități se potrivesc cu „${shortValue(raw)}”; folosește codul unității`,
    };
  }
  const unit = distinct[0] as ImportUnit;
  if (unit.code === DEFAULT_MEASURE_UNIT_CODE) {
    return { ok: true, value: { id: null, unit: null, decimals: 0 } };
  }
  if (!unit.isActive) {
    return { ok: false, text: `unitatea „${shortValue(raw)}” este dezactivată` };
  }
  return { ok: true, value: { id: unit.id, unit, decimals: unit.decimals } };
}

/** Pas sau raport: cantitate pozitivă cu cel mult 4 zecimale, în zecimi de miime, EXACT (fără `float`). */
function parseTicks(
  raw: string,
  label: string,
): { ok: true; ticks: number } | { ok: false; text: string } {
  let quantity: Quantity;
  try {
    quantity = parseQuantity(raw);
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    return {
      ok: false,
      text: `valoare invalidă „${shortValue(raw)}” (${label}, cu virgulă, cel mult 4 zecimale)`,
    };
  }
  if (quantity <= 0n) return { ok: false, text: "trebuie să fie mai mare decât zero" };
  try {
    return { ok: true, ticks: saleStepToInt(quantity) };
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    return { ok: false, text: "valoarea e prea mare (cel mult 214.748 de unități)" };
  }
}

function parseWholeNumber(
  raw: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; text: string } {
  const cleaned = raw.replace(/\s+/g, "");
  const value = /^[0-9]{1,9}$/.test(cleaned) ? Number.parseInt(cleaned, 10) : -1;
  if (value < min || value > max) {
    return {
      ok: false,
      text: `valoare invalidă „${shortValue(raw)}” (${label}, între ${min} și ${max})`,
    };
  }
  return { ok: true, value };
}

/**
 * Citește coloanele de vânzare dintr-un rând. `values`: textul fiecărui câmp mapat (lipsă = celulă goală, `null` = «-»).
 * Întoarce valorile valide și TOATE erorile (nu doar prima), fiecare cu câmpul ei.
 */
export function parseSaleValues(
  values: Partial<Record<ImportFieldKey, string | null>>,
  units: readonly ImportUnit[],
): { sale: SaleValues; errors: SaleError[] } {
  const sale: SaleValues = {};
  const errors: SaleError[] = [];
  const fail = (field: ImportFieldKey, text: string) => errors.push({ field, text });

  if ("unit" in values) {
    const raw = values.unit;
    if (raw === null || raw === undefined) sale.unit = { id: null, unit: null, decimals: 0 };
    else {
      const resolved = resolveUnit(raw, units);
      if (resolved.ok) sale.unit = resolved.value;
      else fail("unit", resolved.text);
    }
  }

  if ("priceBasis" in values) {
    const raw = values.priceBasis;
    const basis = raw === null || raw === undefined ? undefined : BASIS[foldText(raw)];
    if (basis) sale.priceBasis = basis;
    else if (raw === null) fail("priceBasis", "valoarea nu se poate șterge cu „-”");
    else if (raw !== undefined) {
      fail("priceBasis", `valoare necunoscută „${shortValue(raw)}” (Pe unitate sau Pe pas)`);
    }
  }

  if ("saleStep" in values) {
    const raw = values.saleStep;
    if (raw === null) sale.saleStep = null;
    else if (raw !== undefined) {
      const parsed = parseTicks(raw, "pas de vânzare");
      if (parsed.ok) sale.saleStep = parsed.ticks;
      else fail("saleStep", parsed.text);
    }
  }

  if ("minSteps" in values) {
    const raw = values.minSteps;
    if (raw === null) sale.minSteps = null;
    else if (raw !== undefined) {
      const parsed = parseWholeNumber(raw, 1, 1_000_000, "număr întreg de pași");
      if (parsed.ok) sale.minSteps = parsed.value;
      else fail("minSteps", parsed.text);
    }
  }

  if ("saleStepLabel" in values) {
    const raw = values.saleStepLabel;
    if (raw === null) sale.saleStepLabel = null;
    else if (raw !== undefined) {
      const text = raw.trim();
      if (text.length > 30) fail("saleStepLabel", "cel mult 30 de caractere");
      else sale.saleStepLabel = text === "" ? null : text;
    }
  }

  if ("smartbillMode" in values) {
    const raw = values.smartbillMode;
    if (raw === null) sale.smartbillMode = null;
    else if (raw !== undefined) {
      const mode = MODES[foldText(raw)];
      if (mode) sale.smartbillMode = mode;
      else {
        fail(
          "smartbillMode",
          `valoare necunoscută „${shortValue(raw)}” (Aceeași unitate, Pași sau Raport)`,
        );
      }
    }
  }

  if ("smartbillUnitName" in values) {
    const raw = values.smartbillUnitName;
    if (raw === null) sale.smartbillUnitName = null;
    else if (raw !== undefined) {
      const text = raw.trim();
      if (text.length > 40) fail("smartbillUnitName", "cel mult 40 de caractere");
      else sale.smartbillUnitName = text === "" ? null : text;
    }
  }

  if ("smartbillRatio" in values) {
    const raw = values.smartbillRatio;
    if (raw === null) sale.smartbillRatio = null;
    else if (raw !== undefined) {
      const parsed = parseTicks(raw, "raport");
      if (parsed.ok) sale.smartbillRatio = parsed.ticks;
      else fail("smartbillRatio", parsed.text);
    }
  }

  if ("stockStatus" in values) {
    const raw = values.stockStatus;
    const status = raw === null || raw === undefined ? undefined : STATUSES[foldText(raw)];
    if (status) sale.stockStatus = status;
    else if (raw === null) fail("stockStatus", "valoarea nu se poate șterge cu „-”");
    else if (raw !== undefined) {
      fail(
        "stockStatus",
        `valoare necunoscută „${shortValue(raw)}” (În stoc, Stoc epuizat sau La comandă)`,
      );
    }
  }

  if ("leadTimeDays" in values) {
    const raw = values.leadTimeDays;
    if (raw === null) sale.leadTimeDays = null;
    else if (raw !== undefined) {
      const parsed = parseWholeNumber(raw, 0, 365, "număr întreg de zile");
      if (parsed.ok) sale.leadTimeDays = parsed.value;
      else fail("leadTimeDays", parsed.text);
    }
  }

  return { sale, errors };
}

// ---------------------------------------------------------------------------
// Planificarea: pe produs sau pe variantă, verificări pe configurația EFECTIVĂ
// ---------------------------------------------------------------------------

/** O unitate (1,0000) în zecimi de miime, ca număr: pasul când nici varianta, nici produsul nu au unul. */
const ONE_UNIT = Number(QUANTITY_FACTOR);

export interface SaleDecision {
  /** Coloanele produsului care se schimbă (se adaugă la `productPatch` al rândului) */
  productPatch: Record<string, unknown>;
  /** Coloanele variantei (suprascrieri și conversie SmartBill) */
  variantPatch: Record<string, unknown>;
  /** Etichetele câmpurilor care se schimbă (pentru raport) */
  changed: string[];
  warnings: string[];
  /** Mesaje complete, cu eticheta câmpului în față */
  errors: string[];
}

/** Un rând al fișierului care vizează o variantă existentă. */
export interface SaleRow {
  /** Poziția rândului în fișier (cheia deciziei) */
  index: number;
  variantId: string;
  sale: ExistingSale;
  values: SaleValues;
  /** Rândul are erori (de citire sau de valoare): grupul nu mai poate fi tratat ca uniform */
  failed: boolean;
}

const label = (key: ImportFieldKey): string => importField(key).label;

const ISSUE_FIELD: Record<string, ImportFieldKey> = {
  saleStep: "saleStep",
  smartbillRatio: "smartbillRatio",
  smartbillMode: "smartbillMode",
};

function emptyDecision(): SaleDecision {
  return { productPatch: {}, variantPatch: {}, changed: [], warnings: [], errors: [] };
}

/** Conversia SmartBill după rând: modul, raportul și numele unității, coerente (CHECK: «una setată, una nulă»). */
function nextSmartbill(
  current: ExistingSale["variant"],
  given: SaleValues,
): {
  mode: string | null;
  ratio: number | null;
  name: string | null;
  touched: boolean;
  error: string | null;
} {
  const modeGiven = given.smartbillMode !== undefined;
  const mode: string | null = modeGiven ? (given.smartbillMode ?? null) : current.smartbillMode;
  let ratio: number | null;
  if (given.smartbillRatio !== undefined) ratio = given.smartbillRatio;
  else if (modeGiven && mode !== "ratio") ratio = null;
  else ratio = current.smartbillRatio;
  const name =
    given.smartbillUnitName !== undefined ? given.smartbillUnitName : current.smartbillUnitName;
  const touched = modeGiven || given.smartbillRatio !== undefined;
  let error: string | null = null;
  if (touched) {
    if (ratio !== null && mode !== "ratio") {
      error = `${label("smartbillRatio")}: se folosește doar cu modul «Raport»; setează și „${label("smartbillMode")}”`;
    } else if (mode === "ratio" && ratio === null) {
      error = `${label("smartbillRatio")}: modul «Raport» cere raportul`;
    }
  }
  return { mode, ratio, name, touched, error };
}

/** Verifică configurația FINALĂ (zecimalele unității, pasul, conversia SmartBill) și întoarce mesajele. */
function checkFinal(
  units: readonly ImportUnit[],
  unitId: string | null,
  step: number,
  mode: string | null,
  ratio: number | null,
): string[] {
  const decimals = unitId === null ? 0 : (units.find((u) => u.id === unitId)?.decimals ?? 0);
  return checkSaleConfig({
    unitDecimals: decimals,
    step: BigInt(step),
    smartbillMode: mode,
    smartbillRatio: ratio,
  }).map((issue) => `${label(ISSUE_FIELD[issue.path] ?? "saleStep")}: ${issue.message}`);
}

interface BothLevelSpec<T> {
  field: ImportFieldKey;
  column: string;
  /** Valoarea din fișier, normalizată; `undefined` = celulă goală */
  provided: (row: SaleRow) => T | undefined;
  /** Valoarea EFECTIVĂ de acum (varianta peste produs peste implicit), normalizată */
  effective: (row: SaleRow) => T;
  /** Suprascrierea proprie a variantei (nul = moștenește) */
  own: (row: SaleRow) => unknown;
  /** Valoarea produsului, normalizată */
  product: T;
  equal: (a: T, b: T) => boolean;
  toProduct: (value: T) => unknown;
  toVariant: (value: T) => unknown;
  /** Rândurile la care se aplică (ex. doar variantele negestionate la «Stare stoc») */
  eligible?: (row: SaleRow) => boolean;
}

/**
 * Regula «pe produs sau pe variantă» pentru un câmp care există la ambele niveluri: aceeași valoare la TOATE rândurile unui
 * produs (și fișierul conține toate variantele lui, fără rânduri greșite) → pe produs, iar suprascrierile variantelor se
 * golesc; altfel pe fiecare variantă cu valoare. Întoarce valoarea FINALĂ pe rând (pentru verificările de configurație).
 */
function decide<T>(
  rows: readonly SaleRow[],
  decisions: Map<number, SaleDecision>,
  covered: boolean,
  spec: BothLevelSpec<T>,
): Map<number, T> {
  const eligible = spec.eligible ?? (() => true);
  const final = new Map<number, T>(rows.map((r) => [r.index, spec.effective(r)]));
  const given = rows.filter((r) => eligible(r) && spec.provided(r) !== undefined);
  if (given.length === 0) return final;
  const labelOf = label(spec.field);
  const mark = (row: SaleRow) => {
    const d = decisions.get(row.index) as SaleDecision;
    if (!d.changed.includes(labelOf)) d.changed.push(labelOf);
  };

  const first = spec.provided(given[0] as SaleRow) as T;
  const uniform =
    covered &&
    rows.every((r) => !r.failed && eligible(r) && spec.provided(r) !== undefined) &&
    rows.every((r) => spec.equal(spec.provided(r) as T, first));
  if (uniform) {
    if (rows.every((r) => spec.equal(spec.effective(r), first))) return final;
    const productChanges = !spec.equal(spec.product, first);
    for (const row of rows) {
      const d = decisions.get(row.index) as SaleDecision;
      if (productChanges) {
        d.productPatch[spec.column] = spec.toProduct(first);
        mark(row);
      }
      if (spec.own(row) !== null) {
        d.variantPatch[spec.column] = null;
        mark(row);
      }
      final.set(row.index, first);
    }
    return final;
  }
  for (const row of given) {
    const value = spec.provided(row) as T;
    if (spec.equal(spec.effective(row), value)) continue;
    (decisions.get(row.index) as SaleDecision).variantPatch[spec.column] = spec.toVariant(value);
    mark(row);
    final.set(row.index, value);
  }
  return final;
}

/**
 * Planul coloanelor de vânzare pentru rândurile care vizează variante ale ACELUIAȘI produs existent. Regula «pe produs sau pe
 * variantă», denumirea pasului și termenul (pe produs), conversia SmartBill (pe variantă), «Stare stoc» doar la negestionate,
 * apoi verificarea configurației finale (zecimalele unității, pasul, raportul exact). Pură: nu citește nimic din bază.
 */
export function planExistingSale(
  rows: readonly SaleRow[],
  units: readonly ImportUnit[],
): Map<number, SaleDecision> {
  const decisions = new Map<number, SaleDecision>(rows.map((r) => [r.index, emptyDecision()]));
  const head = rows[0];
  if (!head) return decisions;
  const product = head.sale.product;
  const covered = product.variantIds.every((id) => rows.some((r) => r.variantId === id));
  const defaultUnit = units.find((u) => u.code === DEFAULT_MEASURE_UNIT_CODE);

  const unitOf = (r: SaleRow): string | null =>
    r.sale.variant.measureUnitId ?? product.measureUnitId;
  const finalUnit = decide<string | null>(rows, decisions, covered, {
    field: "unit",
    column: "measureUnitId",
    provided: (r) => (r.values.unit === undefined ? undefined : r.values.unit.id),
    effective: unitOf,
    own: (r) => r.sale.variant.measureUnitId,
    product: product.measureUnitId,
    equal: (a, b) => a === b,
    toProduct: (id) => id,
    // pe o variantă, «buc» se scrie ca unitatea «buc» explicită (nul ar însemna «moștenește»)
    toVariant: (id) => id ?? defaultUnit?.id ?? null,
  });
  for (const row of rows) {
    const d = decisions.get(row.index) as SaleDecision;
    if (
      "measureUnitId" in d.variantPatch &&
      d.variantPatch["measureUnitId"] === null &&
      finalUnit.get(row.index) === null &&
      product.measureUnitId !== null &&
      !("measureUnitId" in d.productPatch)
    ) {
      d.errors.push(
        `${label("unit")}: unitatea «buc» nu există în Unități de măsură, deci nu se poate aplica pe o singură variantă`,
      );
    }
  }

  decide<string>(rows, decisions, covered, {
    field: "priceBasis",
    column: "priceBasis",
    provided: (r) => r.values.priceBasis,
    effective: (r) => r.sale.variant.priceBasis ?? product.priceBasis,
    own: (r) => r.sale.variant.priceBasis,
    product: product.priceBasis,
    equal: (a, b) => a === b,
    toProduct: (v) => v,
    toVariant: (v) => v,
  });

  const stepOf = (r: SaleRow): number => r.sale.variant.saleStep ?? product.saleStep ?? ONE_UNIT;
  const finalStep = decide<number>(rows, decisions, covered, {
    field: "saleStep",
    column: "saleStep",
    provided: (r) =>
      r.values.saleStep === undefined ? undefined : (r.values.saleStep ?? ONE_UNIT),
    effective: stepOf,
    own: (r) => r.sale.variant.saleStep,
    product: product.saleStep ?? ONE_UNIT,
    equal: (a, b) => a === b,
    toProduct: (v) => (v === ONE_UNIT ? null : v),
    toVariant: (v) => v,
  });

  decide<number>(rows, decisions, covered, {
    field: "minSteps",
    column: "minSteps",
    provided: (r) => (r.values.minSteps === undefined ? undefined : (r.values.minSteps ?? 1)),
    effective: (r) => r.sale.variant.minSteps ?? product.minSteps ?? 1,
    own: (r) => r.sale.variant.minSteps,
    product: product.minSteps ?? 1,
    equal: (a, b) => a === b,
    toProduct: (v) => (v === 1 ? null : v),
    toVariant: (v) => v,
  });

  // «Stare stoc»: doar variantele efectiv negestionate ale produselor fizice
  const isUnmanaged = (r: SaleRow): boolean =>
    product.type !== "digital" && !(r.sale.variant.manageStock ?? product.manageStock);
  for (const row of rows) {
    if (row.values.stockStatus === undefined || isUnmanaged(row)) continue;
    (decisions.get(row.index) as SaleDecision).warnings.push(
      product.type === "digital"
        ? `${label("stockStatus")}: ignorată, produsul e digital (nu are stoc)`
        : `${label("stockStatus")}: ignorată, stocul variantei e gestionat (cantitățile vin din inventar; starea se alege doar la produsele negestionate)`,
    );
  }
  decide<string>(rows, decisions, covered, {
    field: "stockStatus",
    column: "stockStatus",
    provided: (r) => r.values.stockStatus,
    effective: (r) => r.sale.variant.stockStatus ?? product.stockStatus,
    own: (r) => r.sale.variant.stockStatus,
    product: product.stockStatus,
    equal: (a, b) => a === b,
    toProduct: (v) => v,
    toVariant: (v) => v,
    eligible: isUnmanaged,
  });

  for (const row of rows) {
    const d = decisions.get(row.index) as SaleDecision;
    const v = row.values;
    // pe produs: denumirea pasului și termenul (variantele aceluiași produs cu valori diferite le prinde planificatorul)
    if (v.saleStepLabel !== undefined && v.saleStepLabel !== product.saleStepLabel) {
      d.productPatch["saleStepLabel"] = v.saleStepLabel;
      d.changed.push(label("saleStepLabel"));
    }
    if (v.leadTimeDays !== undefined && v.leadTimeDays !== product.leadTimeDays) {
      d.productPatch["leadTimeDays"] = v.leadTimeDays;
      d.changed.push(label("leadTimeDays"));
    }
    // pe variantă: conversia SmartBill
    const sb = nextSmartbill(row.sale.variant, v);
    if (sb.error) d.errors.push(sb.error);
    const current = row.sale.variant;
    if (sb.mode !== current.smartbillMode || sb.ratio !== current.smartbillRatio) {
      d.variantPatch["smartbillMode"] = sb.mode;
      d.variantPatch["smartbillRatio"] = sb.ratio;
      if (v.smartbillMode !== undefined) d.changed.push(label("smartbillMode"));
      if (v.smartbillRatio !== undefined) d.changed.push(label("smartbillRatio"));
    }
    if (sb.name !== current.smartbillUnitName) {
      d.variantPatch["smartbillUnitName"] = sb.name;
      d.changed.push(label("smartbillUnitName"));
    }
    // configurația finală, doar dacă rândul o atinge
    const touched =
      "measureUnitId" in d.variantPatch ||
      "measureUnitId" in d.productPatch ||
      "saleStep" in d.variantPatch ||
      "saleStep" in d.productPatch ||
      sb.touched;
    if (touched && !sb.error) {
      d.errors.push(
        ...checkFinal(
          units,
          finalUnit.get(row.index) ?? null,
          finalStep.get(row.index) ?? ONE_UNIT,
          sb.mode,
          sb.ratio,
        ),
      );
    }
  }
  return decisions;
}

export interface NewSalePlan {
  /** Se adaugă la datele produsului nou */
  product: Record<string, unknown>;
  /** Se adaugă la datele primei variante */
  variant: Record<string, unknown>;
  errors: string[];
}

/**
 * Un produs NOU (o singură variantă): valorile merg pe produs, conversia SmartBill pe variantă. Importul creează produsele
 * NEGESTIONATE (`manageStock = false`, explicit): inventarul îl face utilizatorul; «Stare stoc» se aplică direct.
 */
export function planNewSale(sale: SaleValues, units: readonly ImportUnit[]): NewSalePlan {
  const product: Record<string, unknown> = { manageStock: false };
  const variant: Record<string, unknown> = {};
  const errors: string[] = [];
  if (sale.unit !== undefined) product["measureUnitId"] = sale.unit.id;
  if (sale.priceBasis !== undefined) product["priceBasis"] = sale.priceBasis;
  if (sale.saleStep != null) product["saleStep"] = sale.saleStep;
  if (sale.minSteps != null) product["minSteps"] = sale.minSteps;
  if (sale.saleStepLabel != null) product["saleStepLabel"] = sale.saleStepLabel;
  if (sale.leadTimeDays != null) product["leadTimeDays"] = sale.leadTimeDays;
  if (sale.stockStatus !== undefined) product["stockStatus"] = sale.stockStatus;

  const sb = nextSmartbill(emptyExistingSale().variant, sale);
  if (sb.error) errors.push(sb.error);
  if (sb.mode !== null) {
    variant["smartbillMode"] = sb.mode;
    variant["smartbillRatio"] = sb.ratio;
  }
  if (sb.name !== null) variant["smartbillUnitName"] = sb.name;

  const touched = sale.unit !== undefined || sale.saleStep != null || sb.touched;
  if (touched && !sb.error) {
    errors.push(
      ...checkFinal(
        units,
        sale.unit === undefined ? null : sale.unit.id,
        sale.saleStep ?? ONE_UNIT,
        sb.mode,
        sb.ratio,
      ),
    );
  }
  return { product, variant, errors };
}
