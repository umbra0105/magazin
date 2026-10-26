import type {
  AdjustmentWarning,
  ProductStockSummary,
  StockOverviewRow,
  WarehouseFreshness,
} from "@ecom/core";
import {
  formatQuantity,
  formatSignedDelta,
  type Quantity,
  type QuantityDelta,
} from "@ecom/shared/quantity";
import { getMessages } from "@/messages";
import { formatLocalDateTime } from "./stock-time";

/**
 * Textele ecranului de stoc (română): pluralul pașilor și al zilelor, cantități cu unitate, starea vizibilă, banner-ul «stoc
 * verificat la …» și avertismentele ajustării. Tot textul vine din `messages/ro.ts`; aici doar se alege și se asamblează.
 * Cantitățile se formatează exclusiv prin `Quantity` (virgulă zecimală, fără zerouri de prisos).
 */

const m = () => getMessages().admin.inventory;

export type Tone = "ok" | "warn" | "danger" | "info";

interface PluralForms {
  one: string;
  few: string;
  many: string;
}

/** Plural românesc: 1 → singular; 0 și 2–19 (inclusiv 102–119) → «pași»; 20+ și sutele rotunde → «de pași». */
function pluralWord(n: bigint, forms: PluralForms): string {
  if (n === 1n) return forms.one;
  const rest = n % 100n;
  return n === 0n || (rest >= 1n && rest <= 19n) ? forms.few : forms.many;
}

export function stepsText(steps: bigint): string {
  return `${steps} ${pluralWord(steps, m().plural.step)}`;
}

export function daysText(days: number): string {
  return `${days} ${pluralWord(BigInt(days), m().plural.day)}`;
}

export function quantityText(value: Quantity | bigint, unit: { symbol: string }): string {
  return `${formatQuantity(value as Quantity)} ${unit.symbol}`;
}

export function deltaText(delta: QuantityDelta, unit: { symbol: string }): string {
  return `${formatSignedDelta(delta)} ${unit.symbol}`;
}

export interface AvailabilityView {
  quantity: string;
  steps: string;
  /** Restul nevandabil, doar dacă există */
  remainder: string | null;
}

/** «100 mp = 2 pași · rest 17,5 mp». `null` la negestionat și digital (nu au cantități). */
export function availabilityView(row: StockOverviewRow): AvailabilityView | null {
  if (row.kind !== "managed" || row.available === null || row.availableSteps === null) return null;
  return {
    quantity: quantityText(row.available, row.unit),
    steps: stepsText(row.availableSteps),
    remainder:
      row.remainder !== null && row.remainder > 0n ? quantityText(row.remainder, row.unit) : null,
  };
}

export interface ThresholdView {
  /** «2 pași», «1 pas», «20 de pași» */
  steps: string;
  origin: "own" | "global";
  /** «propriu» sau «setarea globală» */
  originLabel: string;
}

/** Pragul «stoc mic» efectiv al unei variante și de unde vine. `null` la negestionat și digital (nu au prag). */
export function thresholdView(row: StockOverviewRow): ThresholdView | null {
  if (row.thresholdSteps === null) return null;
  const origin = row.ownThresholdSteps === null ? "global" : "own";
  return {
    steps: stepsText(BigInt(row.thresholdSteps)),
    origin,
    originLabel: m().lowStock.threshold[origin],
  };
}

export interface ThresholdTargetData {
  variantId: string;
  warehouseId: string;
  name: string;
  /** Pragul propriu de acum; `null` = setarea globală */
  ownSteps: number | null;
  effectiveText: string;
  originLabel: string;
  globalText: string;
}

/** Ce primește dialogul «Prag» pentru un rând (formatat aici, ca dialogul să nu știe de pluraluri). `null` la negestionat și digital. */
export function thresholdTarget(
  row: StockOverviewRow,
  context: { warehouseId: string; name: string; globalSteps: number },
): ThresholdTargetData | null {
  const view = thresholdView(row);
  if (!view) return null;
  return {
    variantId: row.variantId,
    warehouseId: context.warehouseId,
    name: context.name,
    ownSteps: row.ownThresholdSteps,
    effectiveText: view.steps,
    originLabel: view.originLabel,
    globalText: stepsText(BigInt(context.globalSteps)),
  };
}

export interface LowStockReasonView {
  reason: NonNullable<StockOverviewRow["lowStockReason"]>;
  label: string;
  tone: Tone;
}

/** Motivul din lista «Stoc mic» (epuizat / doar rest nevandabil / sub prag), cu tonul insignei. `null` = nu e în listă. */
export function lowStockReasonView(row: StockOverviewRow): LowStockReasonView | null {
  const reason = row.lowStockReason;
  if (!reason) return null;
  return {
    reason,
    label: m().lowStock.reasons[reason],
    tone: reason === "out_of_stock" ? "danger" : "warn",
  };
}

export interface StateView {
  label: string;
  tone: Tone;
  detail?: string;
}

/** Starea vizibilă, cu explicația scurtă (cât mai sunt, termenul, restul nevandabil). */
export function stateView(row: StockOverviewRow): StateView {
  const text = m();
  if (row.kind === "unmanaged" && row.stockStatus) {
    const tone: Tone =
      row.stockStatus === "instock" ? "ok" : row.stockStatus === "outofstock" ? "danger" : "info";
    return {
      label: text.stockStatus[row.stockStatus],
      tone,
      ...(row.stockStatus === "onbackorder" && row.leadTimeDays !== null
        ? { detail: text.details.leadTime(daysText(row.leadTimeDays)) }
        : {}),
    };
  }
  const label = text.states[row.state];
  if (row.state === "in_stock") return { label, tone: "ok" };
  if (row.state === "limited") {
    return {
      label,
      tone: "warn",
      ...(row.availableSteps !== null
        ? { detail: text.details.limited(stepsText(row.availableSteps)) }
        : {}),
    };
  }
  if (row.state === "on_order") {
    return {
      label,
      tone: "info",
      ...(row.leadTimeDays !== null
        ? { detail: text.details.leadTime(daysText(row.leadTimeDays)) }
        : {}),
    };
  }
  return {
    label,
    tone: "danger",
    ...(row.remainderOnly ? { detail: text.details.remainderOnly } : {}),
  };
}

export interface SummaryView {
  label: string;
  tone: Tone;
  /** «termen 9 zile» la «La comandă» */
  detail?: string;
  /** A doua linie din coloană: cantitatea disponibilă, «Negestionat», «Digital»; `null` fără drept de cantități */
  quantity: string | null;
}

const SUMMARY_TONE: Record<ProductStockSummary["state"], Tone> = {
  in_stock: "ok",
  limited: "warn",
  on_order: "info",
  unavailable: "danger",
};

/** Coloana «Stoc» din lista de produse: starea cea mai bună dintre variante și, dedesubt, cantitatea (doar cu drept de cantități). */
export function summaryView(summary: ProductStockSummary): SummaryView {
  const text = m();
  const cell = text.listCell;
  let quantity: string | null = null;
  if (summary.kind === "digital") quantity = cell.digital;
  else if (summary.kind === "unmanaged") quantity = cell.unmanaged;
  else if (summary.quantity) {
    const amount = cell.available(quantityText(summary.quantity.available, summary.quantity.unit));
    quantity =
      summary.notInventoried && summary.quantity.available === 0n
        ? cell.notInventoried
        : summary.variantCount > 1
          ? cell.variants(summary.variantCount, amount)
          : amount;
  } else if (summary.differentUnits) quantity = cell.differentUnits(summary.variantCount);
  return {
    label: text.states[summary.state],
    tone: SUMMARY_TONE[summary.state],
    ...(summary.state === "on_order" && summary.leadTimeDays !== null
      ? { detail: text.details.leadTime(daysText(summary.leadTimeDays)) }
      : {}),
    quantity,
  };
}

/** Tipul rândului: gestionat, neinventariat (gestionat fără rând de stoc), negestionat, digital. */
export function kindLabel(row: StockOverviewRow): string {
  const text = m().kind;
  if (row.kind === "digital") return text.digital;
  if (row.kind === "unmanaged") return text.unmanaged;
  return row.inventoried ? text.managed : text.notInventoried;
}

const hoursFormat = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 0 });

function ageText(ageHours: number): string {
  const text = m().banner.age;
  if (ageHours < 1) return text.lessThanHour;
  if (ageHours < 48) return text.hours(hoursFormat.format(ageHours));
  return text.days(hoursFormat.format(ageHours / 24));
}

export interface SnapshotView {
  tone: Tone;
  text: string;
}

/** Banner-ul «stoc verificat la …»: proaspăt, vechi (roșu), fără nicio poză, sau depozit fără stoc gestionat. */
export function snapshotView(
  freshness: WarehouseFreshness | null,
  timeZone: string,
  staleHours: number,
): SnapshotView {
  const banner = m().banner;
  if (freshness === null) return { tone: "info", text: banner.none };
  if (freshness.status === "never" || freshness.takenAt === null) {
    return { tone: "danger", text: banner.never };
  }
  const at = formatLocalDateTime(freshness.takenAt, timeZone);
  const age = ageText(freshness.ageHours ?? 0);
  return freshness.status === "stale"
    ? { tone: "danger", text: banner.stale(at, age, staleHours) }
    : { tone: "ok", text: banner.fresh(at, age) };
}

export function warningText(
  code: AdjustmentWarning,
  context: { asOf: Date | null; timeZone: string },
): string {
  const warnings = m().warnings;
  if (code === "below_commitments") return warnings.below_commitments;
  return context.asOf
    ? warnings.effective_before_snapshot(formatLocalDateTime(context.asOf, context.timeZone))
    : warnings.effective_before_snapshot_unknown;
}
