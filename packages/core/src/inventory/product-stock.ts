import { sumQuantities, type Quantity } from "@ecom/shared";
import { resolveLeadTimeDays, type VisibleStockState } from "./availability";
import type { StockOverviewRow, StockOverviewUnit, StockRowKind } from "./stock-overview";

/**
 * Stocul unui PRODUS (Faza 5, punctul 9a): termenul de livrare efectiv cu proveniența lui, rezumatul pe variante pentru
 * coloana «Stoc» din listă și redactarea cantităților pentru cine nu are `inventory.read`. Funcții PURE, pe rândurile
 * ecranului de stoc; toată aritmetica trece prin `Quantity`.
 */

export type LeadTimeOrigin = "product" | "brand" | "global";

/** Termenul «La comandă» al unui produs și de unde vine: produsul, altfel brandul, altfel setarea globală (0 zile e o valoare). */
export function resolveLeadTime(
  sources: { productDays: number | null; brandDays: number | null },
  globalDays: number,
): { days: number; origin: LeadTimeOrigin } {
  const days = resolveLeadTimeDays({ ...sources, globalDays });
  const origin: LeadTimeOrigin =
    sources.productDays !== null ? "product" : sources.brandDays !== null ? "brand" : "global";
  return { days, origin };
}

const STATE_RANK: Record<VisibleStockState, number> = {
  in_stock: 3,
  limited: 2,
  on_order: 1,
  unavailable: 0,
};

export interface ProductStockSummary {
  /** Tipul comun al variantelor, sau «mixed» dacă diferă (gestionate și negestionate în același produs) */
  kind: StockRowKind | "mixed";
  /** Cea mai bună stare dintre variante (ce poate comanda un client) */
  state: VisibleStockState;
  variantCount: number;
  /** La «La comandă»: termenul cel mai scurt dintre variantele la comandă; altfel `null` */
  leadTimeDays: number | null;
  /** Cel puțin o variantă gestionată nu are încă rând de stoc (cantitate zero «până la inventar») */
  notInventoried: boolean;
  /** Suma disponibilului variantelor gestionate, în unitatea lor comună; `null` fără drept de cantități sau fără gestionate */
  quantity: { unit: StockOverviewUnit; available: Quantity } | null;
  /** Variantele gestionate au unități diferite (nu se însumează); doar cu drept de cantități */
  differentUnits: boolean;
}

export function summarizeProductRows(
  rows: readonly StockOverviewRow[],
  options: { withQuantities: boolean },
): ProductStockSummary {
  const first = rows[0];
  if (!first) throw new RangeError("Un produs fără variante nu are stoc de rezumat");

  const kinds = new Set(rows.map((row) => row.kind));
  const kind: StockRowKind | "mixed" = kinds.size === 1 ? first.kind : "mixed";

  let state = first.state;
  for (const row of rows) if (STATE_RANK[row.state] > STATE_RANK[state]) state = row.state;

  let leadTimeDays: number | null = null;
  if (state === "on_order") {
    for (const row of rows) {
      if (row.state !== "on_order" || row.leadTimeDays === null) continue;
      if (leadTimeDays === null || row.leadTimeDays < leadTimeDays) leadTimeDays = row.leadTimeDays;
    }
  }

  const managed = rows.filter((row) => row.kind === "managed");
  let quantity: ProductStockSummary["quantity"] = null;
  let differentUnits = false;
  if (options.withQuantities && managed.length > 0) {
    const unit = (managed[0] as StockOverviewRow).unit;
    if (managed.some((row) => row.unit.code !== unit.code)) differentUnits = true;
    else {
      quantity = {
        unit,
        available: sumQuantities(managed.map((row) => row.available ?? (0n as Quantity))),
      };
    }
  }

  return {
    kind,
    state,
    variantCount: rows.length,
    leadTimeDays,
    notInventoried: managed.some((row) => !row.inventoried),
    quantity,
    differentUnits,
  };
}

/**
 * Rândul fără cantități, pentru cine are `products.read` dar nu `inventory.read`: starea, unitatea, pasul și termenul rămân
 * (sunt informații publice), cantitățile și derivatele lor (alerta de stoc mic, restul) dispar.
 */
export function redactRowQuantities(row: StockOverviewRow): StockOverviewRow {
  return {
    ...row,
    physical: null,
    physicalAsOf: null,
    committed: null,
    reserved: null,
    safetyBuffer: null,
    available: null,
    sellable: null,
    availableSteps: null,
    remainder: null,
    lowStock: false,
    remainderOnly: false,
  };
}
