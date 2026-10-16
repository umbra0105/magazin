import type { ShippingClass } from "../../constants";
import { foldText } from "../import-fields";
import type { ParsedTable } from "../import-file";
import { detectWooColumns, type WooColumnMap } from "./woo-columns";
import { DEFAULT_WOO_OPTIONS } from "./woo-plan";
import type { WooAttributeDef, WooOptions } from "./woo-types";
import { isDimensionUnit, isWeightUnit } from "./woo-values";

/**
 * Ce află utilizatorul despre un fișier WooCommerce înainte să aleagă opțiunile: tipurile de rânduri, clasele
 * de livrare din fișier (cu corespondentul propus), atributele din fișier (cu atributul existent potrivit),
 * unitățile din antet și coloanele ignorate sau blocate. Fără acces la baza de date în afară de lista de
 * atribute primită.
 */

export interface WooAnalysis {
  rowTypes: Record<string, number>;
  units: { weight: string | null; dimensions: string | null };
  /** Opțiunile propuse (unitățile din antet, corespondentele cunoscute pentru clase de livrare). */
  defaults: WooOptions;
  shippingClasses: { name: string; key: string; count: number; suggested: ShippingClass | null }[];
  attributes: { name: string; key: string; count: number; existingId: string | null }[];
  existingAttributes: { id: string; name: string }[];
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}

export function describeWoo(
  table: ParsedTable,
  existing: readonly WooAttributeDef[],
  detected: WooColumnMap = detectWooColumns(table.headers),
): WooAnalysis {
  const cell = (cells: readonly string[], index: number | undefined): string =>
    index === undefined ? "" : (cells[index] ?? "").trim();

  const rowTypes: Record<string, number> = {};
  const classes = new Map<string, { name: string; count: number }>();
  const attributes = new Map<string, { name: string; count: number }>();
  // atributele de pe variații sunt opțiuni de variație ale produsului, nu atribute simple: nu se mapează
  const variationNames = new Set<string>();
  for (const cells of table.rows) {
    if (foldText(cell(cells, detected.roles.type)) !== "variation") continue;
    for (const group of detected.attributes) {
      const name = cell(cells, group.name);
      if (name) variationNames.add(foldText(name));
    }
  }
  for (const cells of table.rows) {
    const type = foldText(cell(cells, detected.roles.type)) || "simple";
    rowTypes[type] = (rowTypes[type] ?? 0) + 1;
    const className = cell(cells, detected.roles.shippingClass);
    if (className) {
      const key = foldText(className);
      classes.set(key, {
        name: classes.get(key)?.name ?? className,
        count: (classes.get(key)?.count ?? 0) + 1,
      });
    }
    for (const group of detected.attributes) {
      const name = cell(cells, group.name);
      if (!name || cell(cells, group.values ?? undefined) === "") continue;
      const key = foldText(name);
      if (variationNames.has(key)) continue;
      attributes.set(key, {
        name: attributes.get(key)?.name ?? name,
        count: (attributes.get(key)?.count ?? 0) + 1,
      });
    }
  }

  const shippingClasses = [...classes.entries()].map(([key, value]) => ({
    key,
    name: value.name,
    count: value.count,
    suggested: DEFAULT_WOO_OPTIONS.shippingClassMap[key] ?? null,
  }));
  const shippingClassMap: WooOptions["shippingClassMap"] = {};
  for (const item of shippingClasses)
    if (item.suggested) shippingClassMap[item.key] = item.suggested;

  const attributeList = [...attributes.entries()].map(([key, value]) => ({
    key,
    name: value.name,
    count: value.count,
    existingId:
      existing.find((a) => foldText(a.name) === key || foldText(a.code) === key)?.id ?? null,
  }));

  return {
    rowTypes,
    units: detected.units,
    defaults: {
      ...DEFAULT_WOO_OPTIONS,
      weightUnit: isWeightUnit(detected.units.weight)
        ? detected.units.weight
        : DEFAULT_WOO_OPTIONS.weightUnit,
      dimensionUnit: isDimensionUnit(detected.units.dimensions)
        ? detected.units.dimensions
        : DEFAULT_WOO_OPTIONS.dimensionUnit,
      shippingClassMap,
    },
    shippingClasses,
    attributes: attributeList,
    existingAttributes: existing.map((a) => ({ id: a.id, name: a.name })),
    ignoredColumns: detected.ignored,
    blockedColumns: detected.blocked,
  };
}
