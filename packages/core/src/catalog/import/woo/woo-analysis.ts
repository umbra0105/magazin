import type { ShippingClass } from "../../constants";
import { parseImageUrl, splitImageCell } from "../../../media/image-url";
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
  /**
   * Imaginile din coloana «Imagini» (doar numărătoare pe domenii, FĂRĂ rețea): câte adrese, de pe ce domenii,
   * care domenii sunt permise acum și dacă contul poate importa imagini.
   */
  images: {
    hasColumn: boolean;
    total: number;
    /** Adrese care nu respectă regulile (https, portul 443, fără IP/utilizator/fragment): se vor respinge la verificare. */
    invalid: number;
    /** Adrese valide pe domenii din lista permisă / pe alte domenii (total = permise + alte domenii + invalide). */
    onAllowedHosts: number;
    onOtherHosts: number;
    hosts: { host: string; count: number; allowed: boolean }[];
    allowedHosts: string[];
    canImport: boolean;
  };
  ignoredColumns: { header: string; reason: string }[];
  blockedColumns: string[];
}

export function describeWoo(
  table: ParsedTable,
  existing: readonly WooAttributeDef[],
  detected: WooColumnMap = detectWooColumns(table.headers),
  imageContext: { allowedHosts: readonly string[]; canImport: boolean } = {
    allowedHosts: [],
    canImport: false,
  },
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

  let imageTotal = 0;
  let imageInvalid = 0;
  let imageAllowed = 0;
  let imageNotAllowed = 0;
  const imageHosts = new Map<string, number>();
  if (detected.roles.images !== undefined) {
    for (const cells of table.rows) {
      for (const raw of splitImageCell(cell(cells, detected.roles.images))) {
        imageTotal += 1;
        const parsed = parseImageUrl(raw, 4000);
        if (parsed.ok) {
          imageHosts.set(parsed.host, (imageHosts.get(parsed.host) ?? 0) + 1);
          if (imageContext.allowedHosts.includes(parsed.host)) imageAllowed += 1;
          else imageNotAllowed += 1;
        } else imageInvalid += 1;
      }
    }
  }
  const allowedHosts = [...imageContext.allowedHosts];

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
      importImages:
        detected.roles.images !== undefined && imageContext.canImport && allowedHosts.length > 0,
    },
    images: {
      hasColumn: detected.roles.images !== undefined,
      total: imageTotal,
      invalid: imageInvalid,
      onAllowedHosts: imageAllowed,
      onOtherHosts: imageNotAllowed,
      hosts: [...imageHosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([host, count]) => ({ host, count, allowed: allowedHosts.includes(host) })),
      allowedHosts,
      canImport: imageContext.canImport,
    },
    shippingClasses,
    attributes: attributeList,
    existingAttributes: existing.map((a) => ({ id: a.id, name: a.name })),
    ignoredColumns: detected.ignored,
    blockedColumns: detected.blocked,
  };
}
