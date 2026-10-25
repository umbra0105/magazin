import { quantityFromTicks, sumQuantities, type Quantity } from "@ecom/shared";
import { computeAvailability, type StockStatusValue, type VisibleStockState } from "./availability";

/**
 * Modelul de afișare al ecranului de stoc (Faza 5, punctul 8): FUNCȚII PURE care transformă o variantă (cu unitatea, pasul,
 * rândul de stoc și termenele) într-un rând de tabel, și rândurile unui produs într-un grup cu total (D9). Disponibilitatea,
 * pașii și restul vin din `computeAvailability`; aici nu se calculează nimic în plus, doar se alege ce se arată.
 *
 * Trei ramuri, ca peste tot în stoc: **digital** (fără stoc), **negestionat** (doar starea din dropdown, fără cantități) și
 * **gestionat** (cantități reale; fără rând de stoc = «neinventariat», cu zero).
 */

export type StockRowKind = "managed" | "unmanaged" | "digital";

export interface StockOverviewUnit {
  /** Codul unității efective («buc» dacă varianta și produsul n-au una) */
  code: string;
  symbol: string;
  /** Câte zecimale are voie cantitatea (0–4) */
  decimals: number;
}

/** O variantă așa cum o dă sursa de date (valorile sunt deja EFECTIVE: varianta peste produs peste setarea globală). */
export interface StockOverviewSource {
  variantId: string;
  sku: string;
  /** Valorile opțiunilor («1,8 ml · Stejar»), gol pentru produsul fără variante */
  variantLabel: string | null;
  productId: string;
  productTitle: string;
  productSlug: string;
  productType: "physical" | "digital";
  manageStock: boolean;
  stockStatus: StockStatusValue;
  allowBackorder: boolean;
  unit: StockOverviewUnit;
  /** Pasul de vânzare efectiv, în zecimi de miime */
  saleStep: bigint | number;
  minSteps: number | null;
  item: null | {
    physical: Quantity;
    physicalAsOf: Date | null;
    committed: Quantity;
    reserved: Quantity;
    safetyBuffer: Quantity;
    lowStockSteps: number | null;
  };
  leadTime: {
    productDays: number | null;
    brandDays: number | null;
    /** Numele brandului, pentru a arăta de unde vine termenul implicit */
    brandName?: string | null;
  };
}

export interface StockOverviewSettings {
  defaultLowStockSteps: number;
  defaultLeadTimeDays: number;
}

export interface StockOverviewRow {
  variantId: string;
  sku: string;
  variantLabel: string | null;
  productId: string;
  productTitle: string;
  productSlug: string;
  kind: StockRowKind;
  unit: StockOverviewUnit;
  step: Quantity;
  minSteps: number | null;
  /** Gestionat cu rând de stoc; `false` = «neinventariat» (cantitățile sunt zero) */
  inventoried: boolean;
  physical: Quantity | null;
  physicalAsOf: Date | null;
  committed: Quantity | null;
  reserved: Quantity | null;
  safetyBuffer: Quantity | null;
  /** Fizică − Angajat − Rezervat (≥ 0) */
  available: Quantity | null;
  /** Disponibil după tamponul de siguranță: ce se poate vinde */
  sellable: Quantity | null;
  availableSteps: bigint | null;
  /** Restul nevandabil (sub un pas); vizibil doar în admin */
  remainder: Quantity | null;
  state: VisibleStockState;
  /** Doar la negestionat: starea aleasă în dropdown */
  stockStatus: StockStatusValue | null;
  leadTimeDays: number | null;
  lowStock: boolean;
  remainderOnly: boolean;
}

export function buildStockOverviewRow(
  source: StockOverviewSource,
  settings: StockOverviewSettings,
): StockOverviewRow {
  const kind: StockRowKind =
    source.productType === "digital" ? "digital" : source.manageStock ? "managed" : "unmanaged";
  const step = quantityFromTicks(source.saleStep);
  const item = kind === "managed" ? source.item : null;
  const availability = computeAvailability({
    isDigital: kind === "digital",
    manageStock: kind === "managed",
    stockStatus: source.stockStatus,
    allowBackorder: source.allowBackorder,
    step,
    minSteps: source.minSteps,
    inventory: item
      ? {
          physical: item.physical,
          committed: item.committed,
          reserved: item.reserved,
          safetyBuffer: item.safetyBuffer,
          lowStockSteps: item.lowStockSteps,
        }
      : null,
    defaultLowStockSteps: settings.defaultLowStockSteps,
    leadTime: {
      productDays: source.leadTime.productDays,
      brandDays: source.leadTime.brandDays,
      globalDays: settings.defaultLeadTimeDays,
    },
  });
  const zero = 0n as Quantity;
  const managed = kind === "managed";
  return {
    variantId: source.variantId,
    sku: source.sku,
    variantLabel: source.variantLabel,
    productId: source.productId,
    productTitle: source.productTitle,
    productSlug: source.productSlug,
    kind,
    unit: source.unit,
    step,
    minSteps: source.minSteps,
    inventoried: managed && item !== null,
    physical: managed ? (item?.physical ?? zero) : null,
    physicalAsOf: item?.physicalAsOf ?? null,
    committed: managed ? (item?.committed ?? zero) : null,
    reserved: managed ? (item?.reserved ?? zero) : null,
    safetyBuffer: managed ? (item?.safetyBuffer ?? zero) : null,
    available: availability.available,
    sellable: availability.sellable,
    availableSteps: availability.availableSteps,
    remainder: availability.remainder,
    state: availability.state,
    stockStatus: kind === "unmanaged" ? source.stockStatus : null,
    leadTimeDays: availability.leadTimeDays,
    lowStock: availability.lowStock,
    remainderOnly: availability.remainderOnly,
  };
}

export interface StockProductTotal {
  unit: StockOverviewUnit;
  physical: Quantity;
  committed: Quantity;
  reserved: Quantity;
  available: Quantity;
}

export interface StockProductGroup {
  productId: string;
  productTitle: string;
  productSlug: string;
  rows: StockOverviewRow[];
  /** Suma variantelor gestionate; doar dacă sunt cel puțin două și toate au aceeași unitate */
  total: StockProductTotal | null;
  /** De ce nu există total, când ar fi trebuit: unități diferite sau nicio variantă gestionată */
  totalProblem: "different_units" | "no_managed" | null;
}

/** Grupează rândurile pe produs, în ordinea primei apariții, și calculează totalul (D9). */
export function groupStockRows(rows: readonly StockOverviewRow[]): StockProductGroup[] {
  const groups = new Map<string, StockProductGroup>();
  for (const row of rows) {
    const group = groups.get(row.productId);
    if (group) group.rows.push(row);
    else {
      groups.set(row.productId, {
        productId: row.productId,
        productTitle: row.productTitle,
        productSlug: row.productSlug,
        rows: [row],
        total: null,
        totalProblem: null,
      });
    }
  }
  for (const group of groups.values()) {
    if (group.rows.length < 2) continue;
    const managed = group.rows.filter((row) => row.kind === "managed");
    if (managed.length === 0) {
      group.totalProblem = "no_managed";
      continue;
    }
    const first = managed[0] as StockOverviewRow;
    if (managed.some((row) => row.unit.code !== first.unit.code)) {
      group.totalProblem = "different_units";
      continue;
    }
    const pick = (read: (row: StockOverviewRow) => Quantity | null): Quantity =>
      sumQuantities(managed.map((row) => read(row) ?? (0n as Quantity)));
    group.total = {
      unit: first.unit,
      physical: pick((row) => row.physical),
      committed: pick((row) => row.committed),
      reserved: pick((row) => row.reserved),
      available: pick((row) => row.available),
    };
  }
  return [...groups.values()];
}
