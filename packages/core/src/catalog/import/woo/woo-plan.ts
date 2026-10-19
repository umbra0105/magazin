import { createHash } from "node:crypto";
import {
  IMAGE_URL_REJECTION_MESSAGES,
  checkImageUrl,
  parseImageUrl,
  splitImageCell,
} from "../../../media/image-url";
import { parseDecimalInput } from "@ecom/shared/decimal";
import { MAX_CATEGORY_DEPTH } from "../../category-tree";
import { SHIPPING_CLASSES, type ShippingClass } from "../../constants";
import {
  MAX_MONEY,
  MAX_PRODUCT_CATEGORIES,
  PRODUCT_TITLE_MAX_LENGTH,
  SKU_MAX_LENGTH,
} from "../../product-schemas";
import {
  MAX_OPTIONS_PER_PRODUCT,
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_PRODUCT,
} from "../../variant-generator";
import { foldText } from "../import-fields";
import type { ParsedTable } from "../import-file";
import {
  ImportMappingError,
  categoryKey,
  parseLeiToBani,
  type ExistingVariant,
  type ImportCounts,
  type ImportMessage,
  type ImportPlan,
  type ImportSnapshot,
  type PlannedRow,
  type RowOutcome,
} from "../import-plan";
import { htmlToPlainText } from "./html-to-text";
import { detectWooColumns, looksLikeWooExport, type WooRole } from "./woo-columns";
import type {
  WooAttributeDef,
  WooAttributeDraft,
  WooContext,
  WooImagePlan,
  WooCreateOp,
  WooCreations,
  WooOptions,
  WooProductDraft,
  WooRefs,
  WooRelationDraft,
  WooSnapshotExtras,
  WooStats,
  WooUpdateOp,
  WooVariantDraft,
} from "./woo-types";
import {
  DIMENSION_SHIFT,
  WEIGHT_SHIFT,
  isDimensionUnit,
  isPublished,
  isWeightUnit,
  parseMeasure,
  parseWooDate,
  splitCategoryPath,
  splitWooList,
} from "./woo-values";

/**
 * Planificarea unui import WooCommerce: aceeași idee ca `planImport` (funcție PURĂ pe tabel + opțiuni +
 * instantaneul catalogului; nu scrie nimic, deci aceeași funcție face verificarea și calculul pentru
 * aplicare), dar cu regulile exportului WooCommerce:
 *
 *  - rândurile `simple` = un produs cu o variantă; `variable` + `variation` = un produs cu opțiuni și
 *    variante; `grouped`, `external` și alte tipuri sunt IGNORATE cu motiv (niciodată în tăcere);
 *  - SKU = cheia (ca la importul generic); fără SKU: `WC-<ID>`, cu avertisment explicit pe rând;
 *  - celulă goală = neschimbat; produsele noi intră CA CIORNĂ (starea din fișier doar la cerere);
 *  - categoriile, brandurile și atributele LIPSĂ nu se creează în tăcere: se listează în plan, iar crearea
 *    se face la aplicare (cu confirmarea explicită a administratorului), înaintea rândurilor;
 *  - descrierile trec prin `htmlToPlainText` (fără HTML în baza de date);
 *  - unități exacte: kg → g, cm → mm, fără `float`;
 *  - prețul de achiziție și celelalte coloane de cost/furnizor sunt BLOCATE (nu se citesc);
 *  - stocul, etichetele, imaginile și câmpurile personalizate se ignoră, cu motiv în raport.
 */

export type WooSnapshot = ImportSnapshot & { woo: WooSnapshotExtras };

const zeroStats = (): WooStats => ({
  categoriesToCreate: 0,
  brandsToCreate: 0,
  attributesToCreate: 0,
  unknownShippingClasses: 0,
  descriptionsSanitized: 0,
  descriptionTables: 0,
  descriptionLinks: 0,
  descriptionImages: 0,
  descriptionShortcodes: 0,
  variations: 0,
  unresolvedRelations: 0,
  skuFallbacks: 0,
  legacyNotSaved: 0,
});

export const DEFAULT_WOO_OPTIONS: WooOptions = {
  keepStatus: false,
  weightUnit: "kg",
  dimensionUnit: "cm",
  shippingClassMap: {
    paletizat: "pallet",
    pallet: "pallet",
    supradimensionat: "oversized",
    oversized: "oversized",
    standard: "standard",
  },
  attributeTargets: {},
  importImages: false,
};

/** Motivele respingerii unei imagini la verificare (fără rețea), în română. */
export const WOO_IMAGE_MESSAGES: Readonly<Record<string, string>> = {
  ...IMAGE_URL_REJECTION_MESSAGES,
  too_many_for_product: "prea multe imagini pe produs",
  too_many_for_import: "prea multe imagini în import",
};

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const shortValue = (raw: string): string => (raw.length > 30 ? `${raw.slice(0, 30)}…` : raw);

type RowKind = "simple" | "variable" | "variation" | "other";

interface RowInfo {
  /** Poziția în tabel. */
  i: number;
  /** Numărul rândului din fișier (antetul e 1). */
  row: number;
  cells: readonly string[];
  id: string;
  kind: RowKind;
  /** Tipul brut (pentru motivul rândurilor ignorate). */
  rawType: string;
  rawSku: string;
  /** SKU-ul folosit: cel din fișier sau `WC-<ID>`; gol la produsele variabile fără SKU. */
  sku: string;
}

interface ProductLevel {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  shippingClass?: ShippingClass;
  status?: "draft" | "active";
  /** `undefined` = neschimbat. */
  brandKey?: string | null;
  categoryKeys?: string[];
  attributes: { name: string; values: string[] }[];
  relations: WooRelationDraft[];
  legacyId: string | null;
}

interface VariantLevel {
  price?: number;
  salePrice?: number | null;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
  ean?: string | null;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  legacyId: string | null;
}

function attributeCode(name: string, taken: Set<string>): string {
  let base = foldText(name).replace(/\s+/g, "_");
  if (!/^[a-z]/.test(base)) base = `a_${base}`;
  base = base.slice(0, 44).replace(/_+$/, "") || "atribut";
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}_${n}`;
  taken.add(code);
  return code;
}

export function planWoo(
  table: ParsedTable,
  options: WooOptions,
  snapshot: WooSnapshot,
  ctx: WooContext,
): ImportPlan {
  const columns = detectWooColumns(table.headers);
  if (!looksLikeWooExport(columns)) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Fișierul nu pare un export WooCommerce de produse (lipsesc coloanele ID, Tip, Nume sau Preț). " +
        "Alege profilul «Generic» sau exportă din nou din WooCommerce.",
    );
  }
  const extras = snapshot.woo;
  const fileWarnings: string[] = [...table.warnings];
  const stats = zeroStats();

  // unitățile din antet trebuie să coincidă cu cele alese; unități nesuportate = refuz clar
  const headerWeight = columns.units.weight;
  if (headerWeight !== null && !isWeightUnit(headerWeight)) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      `Greutatea e în «${headerWeight}»; profilul acceptă kg sau g. Exportă greutatea în kg.`,
    );
  }
  const headerDimension = columns.units.dimensions;
  if (headerDimension !== null && !isDimensionUnit(headerDimension)) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      `Dimensiunile sunt în «${headerDimension}»; profilul acceptă cm, mm sau m. Exportă dimensiunile în cm.`,
    );
  }
  if (headerWeight !== null && headerWeight !== options.weightUnit) {
    fileWarnings.push(
      `Antetul de greutate spune «${headerWeight}», dar importul folosește «${options.weightUnit}». Verifică opțiunea de unitate.`,
    );
  }
  if (headerDimension !== null && headerDimension !== options.dimensionUnit) {
    fileWarnings.push(
      `Antetul dimensiunilor spune «${headerDimension}», dar importul folosește «${options.dimensionUnit}». Verifică opțiunea de unitate.`,
    );
  }
  for (const blocked of columns.blocked) {
    fileWarnings.push(
      `Coloana «${shortValue(blocked)}» pare de cost sau de furnizor și nu se citește (prețul de achiziție nu se importă niciodată).`,
    );
  }
  const imageColumns = columns.ignored.filter((c) => c.reason.startsWith("coloană de imagini"));
  if (imageColumns.length > 0) {
    fileWarnings.push(
      `Coloane de imagini în plus (${imageColumns.map((c) => `«${shortValue(c.header)}»`).join(", ")}) au fost ignorate: se citește doar prima.`,
    );
  }
  // imaginile se descarcă în fundal, după produse, doar la cerere și doar cu dreptul de media
  const imagePolicy = options.importImages ? ctx.images : null;
  const imagePlan: WooImagePlan = {
    enabled: imagePolicy !== null && columns.roles.images !== undefined,
    tasks: [],
    issues: [],
    stats: {
      total: 0,
      accepted: 0,
      rejected: 0,
      alreadyInLibrary: 0,
      alreadyAttached: 0,
      ignoredOnVariations: 0,
      byHost: {},
      rejectedByReason: {},
    },
  };
  if (columns.roles.images !== undefined && ctx.images === null) {
    // lipsa dreptului are prioritate: contul nu poate porni opțiunea, deci explicația corectă e cea despre drept
    fileWarnings.push(
      "Imaginile nu se importă: contul nu are dreptul de a încărca fișiere în biblioteca media (media.write).",
    );
  } else if (columns.roles.images !== undefined && !options.importImages) {
    fileWarnings.push(
      "Coloana «Imagini» nu se importă: opțiunea de import al imaginilor e oprită.",
    );
  }
  const stockColumns = columns.ignored.filter((c) => c.reason.startsWith("stocul"));
  if (stockColumns.length > 0) {
    fileWarnings.push(
      `Coloanele de stoc (${stockColumns.map((c) => `«${shortValue(c.header)}»`).join(", ")}) au fost ignorate: stocul nu se importă încă (Faza 5).`,
    );
  }

  const at = (cells: readonly string[], role: WooRole): string => {
    const index = columns.roles[role];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };

  // ---------------------------------------------------------------- rândurile și legăturile dintre ele
  const rows: RowInfo[] = table.rows.map((cells, i) => {
    const rawType = at(cells, "type");
    const folded = foldText(rawType) || "simple";
    const kind: RowKind =
      folded === "simple" || folded === "variable" || folded === "variation" ? folded : "other";
    const id = at(cells, "id");
    const rawSku = at(cells, "sku");
    const sku = kind === "variable" || kind === "other" ? rawSku : rawSku || (id ? `WC-${id}` : "");
    return { i, row: table.rowNumbers[i] as number, cells, id, kind, rawType, rawSku, sku };
  });
  const rowTypes: Record<string, number> = {};
  for (const r of rows) {
    const label = r.kind === "other" ? foldText(r.rawType) || "(necunoscut)" : r.kind;
    rowTypes[label] = (rowTypes[label] ?? 0) + 1;
  }
  const byId = new Map<string, RowInfo>();
  const variableBySku = new Map<string, RowInfo>();
  const fileSkus = new Map<string, RowInfo>();
  for (const r of rows) {
    if (r.id && !byId.has(r.id)) byId.set(r.id, r);
    if (r.kind === "variable" && r.rawSku) variableBySku.set(r.rawSku.toLowerCase(), r);
  }
  const parentOf = (r: RowInfo): RowInfo | null => {
    const raw = at(r.cells, "parent");
    if (!raw) return null;
    const idRef = /^(?:id:)?(\d+)$/i.exec(raw);
    if (idRef) {
      const parent = byId.get(idRef[1] as string);
      return parent && parent.kind === "variable" ? parent : null;
    }
    return variableBySku.get(raw.toLowerCase()) ?? null;
  };
  const kidsOf = new Map<number, RowInfo[]>();
  const parentByKid = new Map<number, RowInfo | null>();
  for (const r of rows) {
    if (r.kind !== "variation") continue;
    const parent = parentOf(r);
    parentByKid.set(r.i, parent);
    if (parent) kidsOf.set(parent.i, [...(kidsOf.get(parent.i) ?? []), r]);
  }

  // ---------------------------------------------------------------- mesaje, creări, referințe
  const messages = new Map<number, ImportMessage[]>();
  const push = (r: RowInfo, level: ImportMessage["level"], text: string): void => {
    messages.set(r.i, [...(messages.get(r.i) ?? []), { level, text }]);
  };
  const err = (r: RowInfo, text: string): void => push(r, "error", text);
  const warn = (r: RowInfo, text: string): void => push(r, "warning", text);
  const hasError = (r: RowInfo): boolean =>
    (messages.get(r.i) ?? []).some((m) => m.level === "error");

  const creations = {
    categories: new Map<string, { key: string; names: string[] }>(),
    brands: new Map<string, { key: string; name: string }>(),
    attributes: new Map<string, { key: string; name: string; code: string }>(),
  };
  const refs: WooRefs = { categoryId: {}, brandId: {}, attributeId: {} };
  const takenCodes = new Set(extras.attributes.map((a) => a.code));

  /** Calea unei categorii: cheia ei, cu categoriile lipsă înregistrate la creat. */
  function resolveCategory(r: RowInfo, path: string): string | null {
    const names = splitCategoryPath(path);
    if (names.some((n) => n === "")) {
      err(r, `Categorii: calea «${shortValue(path)}» are un nivel gol`);
      return null;
    }
    const bad = names.find((n) => n.includes("|"));
    if (bad !== undefined) {
      err(
        r,
        `Categorii: numele «${shortValue(bad)}» conține «|», caracter interzis în numele categoriilor (separă categoriile în importul generic). Redenumește categoria în WooCommerce.`,
      );
      return null;
    }
    const long = names.find((n) => n.length > 150);
    if (long !== undefined) {
      err(r, `Categorii: numele «${shortValue(long)}» are peste 150 de caractere`);
      return null;
    }
    if (names.length - 1 > MAX_CATEGORY_DEPTH) {
      err(
        r,
        `Categorii: calea «${shortValue(path)}» are ${names.length} niveluri; arborele poate avea cel mult ${MAX_CATEGORY_DEPTH + 1}`,
      );
      return null;
    }
    let missing = false;
    for (let depth = 1; depth <= names.length; depth++) {
      const prefix = names.slice(0, depth);
      const key = categoryKey(prefix);
      const known = snapshot.categoryIndex.get(key);
      if (known === null) {
        err(
          r,
          `Categorii: calea «${shortValue(prefix.join(" > "))}» se potrivește cu mai multe categorii`,
        );
        return null;
      }
      if (known !== undefined && !missing) {
        refs.categoryId[key] = known;
        continue;
      }
      missing = true;
      if (!creations.categories.has(key)) creations.categories.set(key, { key, names: prefix });
    }
    return categoryKey(names);
  }

  function resolveBrand(r: RowInfo, name: string): string | null {
    if (name.length > 150) {
      err(r, `Branduri: numele «${shortValue(name)}» are peste 150 de caractere`);
      return null;
    }
    const key = foldText(name);
    const known = snapshot.brandIndex.get(key);
    if (known === null) {
      err(r, `Branduri: există mai multe branduri numite «${shortValue(name)}»`);
      return null;
    }
    if (known !== undefined) refs.brandId[key] = known;
    else if (!creations.brands.has(key)) creations.brands.set(key, { key, name });
    return key;
  }

  /** Atributul din fișier → atribut existent, de creat, sau ignorat (`null`). */
  function resolveAttribute(name: string): { key: string; def: WooAttributeDef | null } | null {
    const key = foldText(name);
    const chosen = options.attributeTargets[key];
    if (chosen === "ignore") return null;
    let def: WooAttributeDef | null = null;
    if (chosen && chosen !== "create") {
      def = extras.attributes.find((a) => a.id === chosen) ?? null;
    } else if (!chosen) {
      def =
        extras.attributes.find((a) => foldText(a.name) === key || foldText(a.code) === key) ?? null;
    }
    if (def) {
      refs.attributeId[key] = def.id;
      return { key, def };
    }
    if (!creations.attributes.has(key)) {
      creations.attributes.set(key, {
        key,
        name: name.slice(0, 100),
        code: attributeCode(name, takenCodes),
      });
    }
    return { key, def: null };
  }

  /** Valoarea unui atribut, în forma serviciului de atribute; `null` dacă nu se potrivește tipului. */
  function attributeValue(
    def: WooAttributeDef | null,
    values: string[],
  ): { value: string | boolean } | { error: string } {
    const joined = values.join(", ");
    if (!def || def.type === "text") {
      if (joined.length > 500) return { error: "textul are peste 500 de caractere" };
      return { value: joined };
    }
    if (def.type === "number") {
      const number = parseDecimalInput(values[0] ?? "");
      return number === null ? { error: "valoarea nu e un număr" } : { value: number };
    }
    if (def.type === "bool") {
      const v = foldText(values[0] ?? "");
      if (["da", "yes", "1", "true"].includes(v)) return { value: true };
      if (["nu", "no", "0", "false"].includes(v)) return { value: false };
      return { error: "valoarea nu e Da/Nu" };
    }
    const option = def.options.find((o) => foldText(o.value) === foldText(values[0] ?? ""));
    return option ? { value: option.id } : { error: "valoarea nu e printre opțiunile listei" };
  }

  // ---------------------------------------------------------------- relații
  function fileTargetSku(ref: string): string | null {
    const idRef = /^id:(\d+)$/i.exec(ref);
    if (idRef) {
      const target = byId.get(idRef[1] as string);
      if (!target) return null;
      if (target.kind === "variable") return kidsOf.get(target.i)?.[0]?.sku || null;
      return target.sku || null;
    }
    const target = fileSkus.get(ref.toLowerCase());
    return target ? target.sku : null;
  }
  for (const r of rows) {
    if (r.kind === "simple" || r.kind === "variation") {
      if (r.sku && !fileSkus.has(r.sku.toLowerCase())) fileSkus.set(r.sku.toLowerCase(), r);
    }
  }

  function relationDrafts(r: RowInfo): WooRelationDraft[] {
    const out: WooRelationDraft[] = [];
    const seen = new Set<string>();
    for (const [role, type] of [
      ["upsells", "upsell"],
      ["crossSells", "crosssell"],
    ] as const) {
      for (const token of splitWooList(at(r.cells, role))) {
        const idRef = /^id:(\d+)$/i.exec(token);
        let target: WooRelationDraft["target"] | null = null;
        const inFile = fileTargetSku(token);
        if (inFile) target = { sku: inFile };
        else if (idRef && extras.productIdByLegacyId.has(idRef[1] as string)) {
          target = { legacyId: idRef[1] as string };
        } else if (!idRef && extras.productIdBySku.has(token.toLowerCase())) {
          target = { sku: token };
        }
        if (!target) {
          stats.unresolvedRelations += 1;
          warn(
            r,
            `${type === "upsell" ? "Upsells" : "Vânzări încrucișate"}: «${shortValue(token)}» nu există în fișier sau în catalog; relația se omite`,
          );
          continue;
        }
        const dedupe = `${type}|${"sku" in target ? `s:${target.sku.toLowerCase()}` : `l:${target.legacyId}`}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ type, target });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- câmpurile unui produs / ale unei variante
  function productLevel(r: RowInfo, isNew: boolean): ProductLevel {
    const level: ProductLevel = { attributes: [], relations: [], legacyId: null };

    const name = at(r.cells, "name");
    if (name) {
      const title = htmlToPlainText(name).text.replace(/\s+/g, " ").trim();
      if (title.length > PRODUCT_TITLE_MAX_LENGTH) {
        err(r, `Nume: cel mult ${PRODUCT_TITLE_MAX_LENGTH} de caractere`);
      } else if (title) level.title = title;
    }
    if (
      isNew &&
      level.title === undefined &&
      !(messages.get(r.i) ?? []).some((m) => m.text.startsWith("Nume"))
    ) {
      err(r, "Nume: obligatoriu la un produs nou");
    }

    const countDescription = (result: ReturnType<typeof htmlToPlainText>, label: string): void => {
      stats.descriptionTables += result.stats.tables;
      stats.descriptionLinks += result.stats.links;
      stats.descriptionImages += result.stats.images;
      stats.descriptionShortcodes += result.stats.shortcodes;
      if (!result.changed) return;
      stats.descriptionsSanitized += 1;
      const parts: string[] = [];
      if (result.stats.tables)
        parts.push(`${result.stats.tables} ${result.stats.tables === 1 ? "tabel" : "tabele"}`);
      if (result.stats.links)
        parts.push(`${result.stats.links} ${result.stats.links === 1 ? "link" : "linkuri"}`);
      if (result.stats.images)
        parts.push(`${result.stats.images} ${result.stats.images === 1 ? "imagine" : "imagini"}`);
      if (result.stats.shortcodes) parts.push(`${result.stats.shortcodes} shortcode-uri`);
      if (result.stats.removedBlocks) parts.push(`${result.stats.removedBlocks} blocuri eliminate`);
      warn(r, `${label}: HTML redus la text simplu${parts.length ? ` (${parts.join(", ")})` : ""}`);
    };

    const short = at(r.cells, "shortDescription");
    if (short) {
      const result = htmlToPlainText(short);
      countDescription(result, "Descriere scurtă");
      let subtitle = result.text.replace(/\s+/g, " ").trim();
      if (subtitle.length > 300) {
        subtitle = `${subtitle.slice(0, 299).trimEnd()}…`;
        warn(r, "Descriere scurtă: scurtată la 300 de caractere (subtitlu)");
      }
      if (subtitle) level.subtitle = subtitle;
    }
    const long = at(r.cells, "description");
    if (long) {
      const result = htmlToPlainText(long, 100_000);
      countDescription(result, "Descriere");
      if (result.truncated) warn(r, "Descriere: tăiată la 100.000 de caractere");
      if (result.text) level.description = result.text;
    }

    const shipping = at(r.cells, "shippingClass");
    if (shipping) {
      const mapped = options.shippingClassMap[foldText(shipping)];
      if (mapped && (SHIPPING_CLASSES as readonly string[]).includes(mapped))
        level.shippingClass = mapped;
      else {
        stats.unknownShippingClasses += 1;
        if (isNew) level.shippingClass = "standard";
        warn(
          r,
          isNew
            ? `Clasă de livrare: «${shortValue(shipping)}» nu are corespondent; produsul primește «standard»`
            : `Clasă de livrare: «${shortValue(shipping)}» nu are corespondent; clasa produsului rămâne neschimbată`,
        );
      }
    } else if (isNew) level.shippingClass = "standard";

    const published = isPublished(at(r.cells, "published")) ? "active" : "draft";
    if (isNew) level.status = options.keepStatus ? published : "draft";
    else if (options.keepStatus) level.status = published;

    const brandCell = at(r.cells, "brands");
    if (brandCell) {
      const names = splitWooList(brandCell);
      if (names.length > 1) {
        warn(
          r,
          `Branduri: sunt ${names.length} branduri; se folosește primul («${shortValue(names[0] as string)}»)`,
        );
      }
      const key = names[0] ? resolveBrand(r, names[0]) : null;
      if (key) level.brandKey = key;
    } else if (isNew) level.brandKey = null;

    const categoryCell = at(r.cells, "categories");
    if (categoryCell) {
      const keys: string[] = [];
      for (const path of splitWooList(categoryCell)) {
        const key = resolveCategory(r, path);
        if (key && !keys.includes(key)) keys.push(key);
      }
      if (keys.length > MAX_PRODUCT_CATEGORIES) {
        err(r, `Categorii: cel mult ${MAX_PRODUCT_CATEGORIES} de categorii pe produs`);
      } else if (keys.length > 0) level.categoryKeys = keys;
    }

    for (const group of columns.attributes) {
      const attrName = (r.cells[group.name] ?? "").trim();
      const valuesCell = group.values === null ? "" : (r.cells[group.values] ?? "").trim();
      if (!attrName || !valuesCell) continue;
      level.attributes.push({ name: attrName, values: splitWooList(valuesCell) });
    }

    level.relations = relationDrafts(r);
    level.legacyId = r.id || null;
    return level;
  }

  function variantLevel(r: RowInfo, isNew: boolean): VariantLevel {
    const level: VariantLevel = { legacyId: r.id || null };

    const priceCell = at(r.cells, "regularPrice");
    if (priceCell) {
      const price = parseLeiToBani(priceCell);
      if (price.ok) level.price = price.value;
      else err(r, `Preț obișnuit: ${price.error}`);
    } else if (isNew) err(r, "Preț obișnuit: obligatoriu la un produs nou");

    const saleCell = at(r.cells, "salePrice");
    if (saleCell) {
      const sale = parseLeiToBani(saleCell);
      if (sale.ok) level.salePrice = sale.value;
      else err(r, `Preț promoțional: ${sale.error}`);
    } else if (isNew) level.salePrice = null;

    for (const [role, field, edge, label] of [
      ["saleFrom", "saleStartsAt", "start", "Dată începere promoție"],
      ["saleTo", "saleEndsAt", "end", "Dată încheiere promoție"],
    ] as const) {
      const cell = at(r.cells, role);
      if (cell) {
        const date = parseWooDate(cell, ctx.timezone, edge);
        if (date.ok) level[field] = date.value.toISOString();
        else err(r, `${label}: ${date.error}`);
      } else if (isNew) level[field] = null;
    }

    const gtin = at(r.cells, "gtin");
    if (gtin) {
      if (/^\d{8,14}$/.test(gtin)) level.ean = gtin;
      else warn(r, `EAN: «${shortValue(gtin)}» nu are 8–14 cifre; se omite`);
    }

    for (const [role, field, shift, label] of [
      ["weight", "weightGrams", WEIGHT_SHIFT[options.weightUnit], "Greutate"],
      ["length", "lengthMm", DIMENSION_SHIFT[options.dimensionUnit], "Lungime"],
      ["width", "widthMm", DIMENSION_SHIFT[options.dimensionUnit], "Lățime"],
      ["height", "heightMm", DIMENSION_SHIFT[options.dimensionUnit], "Înălțime"],
    ] as const) {
      const cell = at(r.cells, role);
      if (!cell) continue;
      const measure = parseMeasure(cell, shift);
      if (!measure.ok) {
        err(r, `${label}: ${measure.error}`);
        continue;
      }
      if (measure.value === null) continue; // 0 = lipsă
      const max = field === "weightGrams" ? 10_000_000 : 100_000;
      if (measure.value > max) err(r, `${label}: valoarea depășește limita`);
      else level[field] = measure.value;
    }

    if (level.price !== undefined && level.price > MAX_MONEY)
      err(r, "Preț obișnuit: depășește plafonul de 10.000.000 de lei");
    if (level.price !== undefined && level.salePrice != null && level.salePrice > level.price) {
      err(r, "Preț promoțional: nu poate depăși prețul obișnuit");
    }
    if (level.saleStartsAt && level.saleEndsAt && level.saleStartsAt > level.saleEndsAt) {
      err(r, "Dată încheiere promoție: promoția se termină înainte să înceapă");
    }
    return level;
  }

  /** Valorile atributelor care NU sunt opțiuni de variație, ca schițe pentru serviciul de atribute. */
  function attributeDrafts(
    r: RowInfo,
    attributes: ProductLevel["attributes"],
    variationNames: Set<string>,
  ): WooAttributeDraft[] {
    const drafts: WooAttributeDraft[] = [];
    for (const attribute of attributes) {
      if (variationNames.has(foldText(attribute.name))) continue;
      const resolved = resolveAttribute(attribute.name);
      if (!resolved) continue;
      const value = attributeValue(resolved.def, attribute.values);
      if ("error" in value) {
        warn(r, `Atribut «${shortValue(attribute.name)}»: ${value.error}; se omite`);
        continue;
      }
      drafts.push({ key: resolved.key, value: value.value });
    }
    return drafts;
  }

  function legacyFor(
    r: RowInfo,
    wanted: string | null,
    current: string | null,
    kind: "product" | "variant",
  ): string | null {
    if (!wanted || wanted === current) return null;
    if (!ctx.canSetLegacy) {
      stats.legacyNotSaved += 1;
      return null;
    }
    const owner =
      kind === "product"
        ? extras.productIdByLegacyId.get(wanted)
        : extras.variantIdByLegacyId.get(wanted);
    if (owner !== undefined) {
      stats.legacyNotSaved += 1;
      warn(
        r,
        `ID din magazinul vechi: «${shortValue(wanted)}» e deja folosit de alt ${kind === "product" ? "produs" : "variantă"}; se omite`,
      );
      return null;
    }
    return wanted;
  }

  // ---------------------------------------------------------------- imagini (fără nicio cerere de rețea)
  /**
   * Adresele din coloana «Imagini» a unui produs: se parsează și trec prin regulile fără rețea (https, port,
   * sintaxă, listă de domenii). Cele acceptate devin sarcini pentru fundal; cele respinse apar în raport cu
   * motivul, FĂRĂ adresa completă. Nu se face nicio cerere în rețea.
   */
  function planImages(r: RowInfo, productSku: string, productId: string | null): void {
    if (!imagePolicy || columns.roles.images === undefined) return;
    const cell = at(r.cells, "images");
    if (!cell) return;
    const attached = productId ? extras.productMedia.get(productId) : undefined;
    const seen = new Set<string>();
    let accepted = 0;
    const stats = imagePlan.stats;
    const reject = (reason: string, host: string | null, index: number, raw: string): void => {
      stats.rejected += 1;
      stats.rejectedByReason[reason] = (stats.rejectedByReason[reason] ?? 0) + 1;
      imagePlan.issues.push({
        row: r.row,
        sku: productSku,
        position: index,
        host,
        reason,
        rawHash: sha256Hex(raw),
      });
      // lista goală de domenii se spune o singură dată (mesaj de fișier), nu pe fiecare imagine
      if (reason !== "no_hosts_configured") {
        warn(
          r,
          `Imagine ${index + 1}${host ? ` (${host})` : ""}: ${WOO_IMAGE_MESSAGES[reason] ?? "adresă respinsă"}`,
        );
      }
    };
    splitImageCell(cell).forEach((raw, index) => {
      stats.total += 1;
      if (accepted >= imagePolicy.maxImagesPerProduct) {
        return reject("too_many_for_product", null, index, raw);
      }
      if (stats.accepted >= imagePolicy.maxImagesPerImport) {
        return reject("too_many_for_import", null, index, raw);
      }
      const check = checkImageUrl(raw, imagePolicy);
      if (!check.ok) return reject(check.reason, check.host, index, raw);
      if (seen.has(check.sourceHash)) return; // aceeași adresă de două ori pe produs: o singură dată
      seen.add(check.sourceHash);
      stats.accepted += 1;
      stats.byHost[check.host] = (stats.byHost[check.host] ?? 0) + 1;
      const mediaId = extras.mediaBySourceHash.get(check.sourceHash);
      if (mediaId && attached?.has(mediaId)) {
        stats.alreadyAttached += 1; // deja în produs: nimic de făcut
      } else {
        if (mediaId) stats.alreadyInLibrary += 1;
        imagePlan.tasks.push({
          row: r.row,
          sku: productSku,
          position: accepted,
          url: check.href,
          sourceHash: check.sourceHash,
          host: check.host,
        });
      }
      accepted += 1;
    });
  }

  /** Imaginile de pe rândurile de variație nu se importă: se spune explicit, o dată pe rând. */
  function ignoreVariationImages(kid: RowInfo): void {
    if (!imagePolicy || columns.roles.images === undefined) return;
    if (!at(kid.cells, "images")) return;
    imagePlan.stats.ignoredOnVariations += 1;
    warn(kid, "Imagini: la variații se ignoră; se folosesc imaginile produsului variabil");
  }

  // ---------------------------------------------------------------- planificarea efectivă
  const planned = new Map<number, PlannedRow>();
  const emit = (
    r: RowInfo,
    outcome: RowOutcome,
    op: PlannedRow["op"] = null,
    changed: string[] = [],
  ): void => {
    const display = r.sku || (r.id ? `ID ${r.id}` : "");
    planned.set(r.i, {
      row: r.row,
      sku: display,
      outcome,
      messages: messages.get(r.i) ?? [],
      changed,
      op,
    });
  };
  const failRow = (r: RowInfo): void => emit(r, "error");

  const seenSkus = new Map<string, number>();
  const skuProblem = (r: RowInfo): boolean => {
    if (!r.sku) {
      err(r, "SKU și ID lipsă: rândul nu se poate identifica");
      return true;
    }
    if (r.sku.length > SKU_MAX_LENGTH) {
      err(r, `SKU: cel mult ${SKU_MAX_LENGTH} de caractere`);
      return true;
    }
    const key = r.sku.toLowerCase();
    const first = seenSkus.get(key);
    if (first !== undefined) {
      err(r, `SKU repetat: apare și la rândul ${first} din fișier`);
      return true;
    }
    seenSkus.set(key, r.row);
    if (!r.rawSku) {
      stats.skuFallbacks += 1;
      warn(r, `SKU lipsă în fișier: se folosește «${r.sku}» (WC-<ID>)`);
    }
    return false;
  };

  const productStatusSkipped = (r: RowInfo, existing: ExistingVariant): boolean => {
    if (existing.product.deleted) {
      warn(
        r,
        "Ignorat: SKU-ul aparține unui produs din coșul de gunoi; restaurează-l ca să-l poți actualiza",
      );
      return true;
    }
    if (existing.product.status === "archived") {
      warn(
        r,
        "Ignorat: SKU-ul aparține unui produs arhivat; dezarhivează-l ca să-l poți actualiza",
      );
      return true;
    }
    return false;
  };

  /** Diferențele dintre fișier și produsul existent, la nivel de produs. */
  function productPatch(
    existing: ExistingVariant["product"],
    productId: string,
    level: ProductLevel,
    variationNames: Set<string>,
    r: RowInfo,
  ): { op: Omit<WooUpdateOp, "variantId" | "variantPatch" | "legacyVariant">; changed: string[] } {
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (label: string, column: string, next: unknown, current: unknown): void => {
      if (next === current) return;
      patch[column] = next;
      changed.push(label);
    };
    if (level.title !== undefined) set("Titlu", "title", level.title, existing.title);
    if (level.subtitle !== undefined)
      set("Subtitlu", "subtitle", level.subtitle, existing.subtitle);
    if (level.description !== undefined)
      set("Descriere", "description", level.description, existing.description);
    if (level.shippingClass !== undefined)
      set("Clasă de livrare", "shippingClass", level.shippingClass, existing.shippingClass);
    if (level.status !== undefined) set("Stare", "status", level.status, existing.status);

    let brandKey: string | null | undefined;
    if (level.brandKey !== undefined && level.brandKey !== null) {
      const id = refs.brandId[level.brandKey];
      if (id === undefined || id !== existing.brandId) {
        brandKey = level.brandKey;
        changed.push("Brand");
      }
    }

    let categoryKeys: string[] | undefined;
    if (level.categoryKeys !== undefined) {
      const ids = level.categoryKeys.map((k) => refs.categoryId[k]);
      const currentIds = existing.categoryIds;
      const same =
        ids.every((id) => id !== undefined) &&
        ids.length === currentIds.length &&
        ids.every((id) => currentIds.includes(id as string)) &&
        ids[0] === currentIds[0];
      if (!same) {
        categoryKeys = level.categoryKeys;
        changed.push("Categorii");
      }
    }

    const attributeValues = attributeDrafts(r, level.attributes, variationNames);
    const currentAttributes =
      extras.products.get(productId)?.attributes ?? new Map<string, string>();
    const attributeChanges = attributeValues.filter((draft) => {
      const attributeId = refs.attributeId[draft.key];
      return (
        attributeId === undefined || currentAttributes.get(attributeId) !== String(draft.value)
      );
    });
    if (attributeChanges.length > 0) changed.push("Atribute");

    const currentRelations = extras.products.get(productId)?.relations ?? new Set<string>();
    const relationChanges = level.relations.filter((relation) => {
      const targetId =
        "sku" in relation.target
          ? extras.productIdBySku.get(relation.target.sku.toLowerCase())
          : extras.productIdByLegacyId.get(relation.target.legacyId);
      return targetId === undefined || !currentRelations.has(`${relation.type}|${targetId}`);
    });
    if (relationChanges.length > 0) changed.push("Relații");

    const legacyProduct = legacyFor(
      r,
      level.legacyId,
      extras.products.get(productId)?.legacyId ?? null,
      "product",
    );
    if (legacyProduct) changed.push("ID din magazinul vechi");

    return {
      op: {
        kind: "woo-update",
        productId,
        productPatch: Object.keys(patch).length > 0 ? patch : null,
        ...(brandKey !== undefined && { brandKey }),
        ...(categoryKeys !== undefined && { categoryKeys }),
        legacyProduct,
        attributeValues: attributeChanges,
        relations: relationChanges,
      },
      changed,
    };
  }

  /** Diferențele dintre fișier și varianta existentă. */
  function variantPatch(
    existing: ExistingVariant,
    level: VariantLevel,
    r: RowInfo,
    legacyOnVariant: boolean,
  ): { patch: Record<string, unknown> | null; legacyVariant: string | null; changed: string[] } {
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const extra = extras.variants.get(existing.variantId);
    const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
    const set = (label: string, column: string, next: unknown, current: unknown): void => {
      if (next === current) return;
      patch[column] = next;
      changed.push(label);
    };
    if (level.price !== undefined) set("Preț", "price", level.price, existing.price);
    if (level.salePrice !== undefined)
      set("Preț promoțional", "salePrice", level.salePrice, existing.salePrice);
    if (level.saleStartsAt !== undefined)
      set("Început promoție", "saleStartsAt", level.saleStartsAt, iso(extra?.saleStartsAt));
    if (level.saleEndsAt !== undefined)
      set("Sfârșit promoție", "saleEndsAt", level.saleEndsAt, iso(extra?.saleEndsAt));
    if (level.ean !== undefined) set("EAN", "ean", level.ean, existing.ean);
    if (level.weightGrams !== undefined)
      set("Greutate", "weightGrams", level.weightGrams, existing.weightGrams);
    if (level.lengthMm !== undefined) set("Lungime", "lengthMm", level.lengthMm, existing.lengthMm);
    if (level.widthMm !== undefined) set("Lățime", "widthMm", level.widthMm, existing.widthMm);
    if (level.heightMm !== undefined)
      set("Înălțime", "heightMm", level.heightMm, existing.heightMm);

    const priceAfter = (patch["price"] as number | undefined) ?? existing.price;
    const saleAfter =
      "salePrice" in patch ? (patch["salePrice"] as number | null) : existing.salePrice;
    if (saleAfter !== null && saleAfter > priceAfter) {
      err(r, "Preț promoțional: nu poate depăși prețul obișnuit (cel din fișier sau cel curent)");
    }
    const legacyVariant = legacyOnVariant
      ? legacyFor(r, level.legacyId, extra?.legacyId ?? null, "variant")
      : null;
    if (legacyVariant) changed.push("ID din magazinul vechi");
    return { patch: Object.keys(patch).length > 0 ? patch : null, legacyVariant, changed };
  }

  const draftOf = (level: ProductLevel): WooProductDraft => ({
    title: level.title as string,
    subtitle: level.subtitle ?? null,
    description: level.description ?? null,
    status: level.status ?? "draft",
    shippingClass: level.shippingClass ?? "standard",
    brandKey: level.brandKey ?? null,
    categoryKeys: level.categoryKeys ?? [],
  });

  const variantDraftOf = (
    r: RowInfo,
    v: VariantLevel,
    selections: WooVariantDraft["selections"],
  ): WooVariantDraft => ({
    sku: r.sku,
    price: v.price as number,
    salePrice: v.salePrice ?? null,
    saleStartsAt: v.saleStartsAt ?? null,
    saleEndsAt: v.saleEndsAt ?? null,
    ean: v.ean ?? null,
    weightGrams: v.weightGrams ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
    legacyId: ctx.canSetLegacy ? v.legacyId : null,
    selections,
  });

  // ------ produse simple
  function planSimple(r: RowInfo): void {
    if (skuProblem(r)) return failRow(r);
    const existing = snapshot.variantsBySku.get(r.sku.toLowerCase());
    if (existing && productStatusSkipped(r, existing)) return emit(r, "skipped");
    const isNew = !existing;
    const product = productLevel(r, isNew);
    const variant = variantLevel(r, isNew);
    if (hasError(r)) return failRow(r);
    planImages(r, r.sku, existing?.productId ?? null);

    if (existing) {
      const prod = productPatch(existing.product, existing.productId, product, new Set(), r);
      const vari = variantPatch(existing, variant, r, false);
      if (hasError(r)) return failRow(r);
      const changed = [...prod.changed, ...vari.changed];
      if (changed.length === 0) return emit(r, "unchanged");
      const op: WooUpdateOp = {
        ...prod.op,
        variantId: existing.variantId,
        variantPatch: vari.patch,
        legacyVariant: null,
      };
      return emit(r, "updated", op, changed);
    }

    const attributeValues = attributeDrafts(r, product.attributes, new Set());
    const legacyId = legacyFor(r, product.legacyId, null, "product");
    const op: WooCreateOp = {
      kind: "woo-create",
      product: draftOf(product),
      variants: [{ ...variantDraftOf(r, variant, []), legacyId: null }],
      options: [],
      attributeValues,
      relations: product.relations,
      legacyId,
      childRows: [],
    };
    return emit(r, "new", op, ["Produs nou"]);
  }

  // ------ produse variabile
  function planVariable(parent: RowInfo): void {
    const kids = kidsOf.get(parent.i) ?? [];
    if (kids.length === 0) {
      err(parent, "Produs variabil fără nicio variație în fișier");
      return failRow(parent);
    }
    stats.variations += kids.length;
    for (const kid of kids) ignoreVariationImages(kid);
    // opțiunile de variație = atributele care apar pe variații
    const variationNames = new Set<string>();
    const kidSelections = new Map<number, { option: string; value: string }[]>();
    const optionValues = new Map<string, { name: string; values: string[] }>();
    for (const kid of kids) {
      const selections: { option: string; value: string }[] = [];
      for (const group of columns.attributes) {
        const attrName = (kid.cells[group.name] ?? "").trim();
        const value = group.values === null ? "" : (kid.cells[group.values] ?? "").trim();
        if (!attrName) continue;
        const key = foldText(attrName);
        if (!value) {
          err(
            kid,
            `Variație: atributul «${shortValue(attrName)}» nu are valoare («oricare» nu e acceptat)`,
          );
          continue;
        }
        variationNames.add(key);
        selections.push({ option: attrName, value });
        const entry = optionValues.get(key) ?? { name: attrName, values: [] };
        if (!entry.values.some((v) => foldText(v) === foldText(value))) entry.values.push(value);
        optionValues.set(key, entry);
      }
      kidSelections.set(kid.i, selections);
    }
    const options = [...optionValues.values()];
    if (options.length === 0) {
      for (const kid of kids)
        err(kid, "Variație fără atribute de variație (nu se știe prin ce diferă de celelalte)");
    }
    if (options.length > MAX_OPTIONS_PER_PRODUCT) {
      err(
        parent,
        `Produsul are ${options.length} opțiuni de variație; limita este ${MAX_OPTIONS_PER_PRODUCT}`,
      );
    }
    for (const option of options) {
      if (option.values.length > MAX_VALUES_PER_OPTION) {
        err(
          parent,
          `Opțiunea «${shortValue(option.name)}» are ${option.values.length} valori; limita este ${MAX_VALUES_PER_OPTION}`,
        );
      }
    }
    if (kids.length > MAX_VARIANTS_PER_PRODUCT) {
      err(parent, `Produsul are ${kids.length} variații; limita este ${MAX_VARIANTS_PER_PRODUCT}`);
    }
    // fiecare variație: exact o valoare pentru fiecare opțiune; combinații unice
    const combos = new Map<string, number>();
    for (const kid of kids) {
      const selections = kidSelections.get(kid.i) ?? [];
      for (const option of options) {
        if (!selections.some((s) => foldText(s.option) === foldText(option.name))) {
          err(kid, `Variație: lipsește valoarea pentru «${shortValue(option.name)}»`);
        }
      }
      const combo = options
        .map((o) =>
          foldText(selections.find((s) => foldText(s.option) === foldText(o.name))?.value ?? ""),
        )
        .join("|");
      const first = combos.get(combo);
      if (first !== undefined)
        err(kid, `Variație: aceeași combinație de valori ca la rândul ${first}`);
      else combos.set(combo, kid.row);
    }

    const kidSkuProblem = new Map<number, boolean>();
    for (const kid of kids) kidSkuProblem.set(kid.i, skuProblem(kid));
    const existingKids = kids.map((k) => ({
      kid: k,
      existing: snapshot.variantsBySku.get(k.sku.toLowerCase()),
    }));
    const existingProducts = new Set(
      existingKids.filter((e) => e.existing).map((e) => e.existing?.productId),
    );

    if (existingProducts.size === 0) {
      // ----- produs nou cu toate variațiile lui
      const product = productLevel(parent, true);
      const variants: WooVariantDraft[] = [];
      for (const kid of kids) {
        const level = variantLevel(kid, true);
        if (!kidSkuProblem.get(kid.i)) {
          variants.push(variantDraftOf(kid, level, kidSelections.get(kid.i) ?? []));
        }
      }
      const attributeValues = attributeDrafts(parent, product.attributes, variationNames);
      const legacyId = legacyFor(parent, product.legacyId, null, "product");
      const failed = hasError(parent) || kids.some((k) => hasError(k));
      if (failed) {
        // un produs variabil nu se creează pe jumătate: toate rândurile lui devin erori
        for (const kid of kids) {
          if (!hasError(kid))
            err(
              kid,
              `Produsul variabil de la rândul ${parent.row} nu se creează: o variație sau produsul are erori`,
            );
          failRow(kid);
        }
        if (!hasError(parent))
          err(parent, "Produsul variabil nu se creează: una dintre variații are erori");
        return failRow(parent);
      }
      planImages(parent, kids[0]?.sku ?? parent.sku, null);
      const op: WooCreateOp = {
        kind: "woo-create",
        product: draftOf(product),
        variants,
        options,
        attributeValues,
        relations: product.relations,
        legacyId,
        childRows: kids.map((k) => k.row),
      };
      emit(parent, "new", op, ["Produs variabil nou"]);
      for (const kid of kids)
        emit(kid, "new", { kind: "woo-child", parentRow: parent.row }, ["Variație nouă"]);
      return;
    }

    // ----- produs existent (re-import): părintele aduce câmpurile produsului, fiecare variație pe ale ei
    if (existingProducts.size > 1) {
      err(parent, "Variațiile acestui produs aparțin unor produse diferite din catalog");
      for (const kid of kids) failRow(kid);
      return failRow(parent);
    }
    const anyExisting = existingKids.find((e) => e.existing)?.existing as ExistingVariant;
    if (productStatusSkipped(parent, anyExisting)) {
      for (const kid of kids) emit(kid, "skipped");
      return emit(parent, "skipped");
    }
    const product = productLevel(parent, false);
    const prod = productPatch(
      anyExisting.product,
      anyExisting.productId,
      product,
      variationNames,
      parent,
    );
    for (const { kid, existing } of existingKids) {
      if (kidSkuProblem.get(kid.i)) {
        failRow(kid);
        continue;
      }
      if (!existing) {
        err(
          kid,
          "Variație nouă la un produs existent: adaug-o din editorul produsului (importul nu adaugă variante la produse existente)",
        );
        failRow(kid);
        continue;
      }
      if (existing.productId !== anyExisting.productId) {
        err(kid, "Variația aparține altui produs din catalog");
        failRow(kid);
        continue;
      }
      const level = variantLevel(kid, false);
      const vari = variantPatch(existing, level, kid, true);
      if (hasError(kid)) {
        failRow(kid);
        continue;
      }
      if (!vari.patch && !vari.legacyVariant) {
        emit(kid, "unchanged");
        continue;
      }
      const op: WooUpdateOp = {
        kind: "woo-update",
        productId: existing.productId,
        variantId: existing.variantId,
        productPatch: null,
        variantPatch: vari.patch,
        legacyProduct: null,
        legacyVariant: vari.legacyVariant,
        attributeValues: [],
        relations: [],
      };
      emit(kid, "updated", op, vari.changed);
    }
    if (hasError(parent)) return failRow(parent);
    planImages(parent, anyExisting.sku, anyExisting.productId);
    if (prod.changed.length === 0) return emit(parent, "unchanged");
    const op: WooUpdateOp = {
      ...prod.op,
      variantId: null,
      variantPatch: null,
      legacyVariant: null,
    };
    emit(parent, "updated", op, prod.changed);
  }

  for (const r of rows) {
    if (planned.has(r.i)) continue;
    if (r.kind === "simple") planSimple(r);
    else if (r.kind === "variable") planVariable(r);
    else if (r.kind === "variation") {
      if (parentByKid.get(r.i) === null || parentByKid.get(r.i) === undefined) {
        err(
          r,
          "Variație fără produs variabil în fișier (coloana «Părinte» nu indică un produs variabil din acest fișier)",
        );
        failRow(r);
      }
      // variațiile cu părinte sunt emise de planVariable
    } else {
      warn(
        r,
        `Ignorat: tipul «${shortValue(r.rawType)}» nu este acceptat (doar simple, variable și variation)`,
      );
      emit(r, "skipped");
    }
  }
  // variațiile al căror părinte n-a emis nimic (nu ar trebui să se întâmple)
  for (const r of rows) {
    if (!planned.has(r.i)) {
      err(r, "Rândul nu a putut fi planificat");
      failRow(r);
    }
  }

  const ordered = [...planned.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);

  const counts: ImportCounts = {
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
  };
  for (const row of ordered) {
    if (row.outcome === "new") counts.new++;
    else if (row.outcome === "updated") counts.updated++;
    else if (row.outcome === "unchanged") counts.unchanged++;
    else if (row.outcome === "skipped") counts.skipped++;
    else counts.errors++;
    counts.warnings += row.messages.filter((m) => m.level === "warning").length;
  }

  // creările se numără doar pentru ce rămâne după eliminarea rândurilor cu erori? Nu: se listează tot ce
  // cer rândurile valide. Categoriile cerute doar de rânduri cu erori se scot din listă.
  const used = {
    categories: new Set<string>(),
    brands: new Set<string>(),
    attributes: new Set<string>(),
  };
  for (const row of ordered) {
    const op = row.op;
    if (!op) continue;
    const productKeys: {
      brand?: string | null;
      categories?: string[];
      attributes: WooAttributeDraft[];
    } =
      op.kind === "woo-create"
        ? {
            brand: op.product.brandKey,
            categories: op.product.categoryKeys,
            attributes: op.attributeValues,
          }
        : op.kind === "woo-update"
          ? {
              brand: op.brandKey ?? null,
              categories: op.categoryKeys,
              attributes: op.attributeValues,
            }
          : { attributes: [] };
    if (productKeys.brand) used.brands.add(productKeys.brand);
    for (const key of productKeys.categories ?? []) {
      // categoria și toți părinții ei
      let prefix = key;
      used.categories.add(prefix);
      while (prefix.includes(">")) {
        prefix = prefix.slice(0, prefix.lastIndexOf(">"));
        used.categories.add(prefix);
      }
    }
    for (const attribute of productKeys.attributes) used.attributes.add(attribute.key);
  }
  const finalCreations: WooCreations = {
    categories: [...creations.categories.values()]
      .filter((c) => used.categories.has(c.key))
      .sort((a, b) => a.names.length - b.names.length || a.key.localeCompare(b.key)),
    brands: [...creations.brands.values()].filter((b) => used.brands.has(b.key)),
    attributes: [...creations.attributes.values()].filter((a) => used.attributes.has(a.key)),
  };
  stats.categoriesToCreate = finalCreations.categories.length;
  stats.brandsToCreate = finalCreations.brands.length;
  stats.attributesToCreate = finalCreations.attributes.length;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        ordered.map((r) => [r.row, r.sku, r.outcome, r.op]),
        finalCreations,
        refs,
        imagePlan.tasks,
        imagePlan.issues.map((i) => [i.row, i.position, i.reason, i.rawHash]),
      ]),
    )
    .digest("hex");

  return {
    rows: ordered,
    counts,
    fileWarnings,
    fingerprint,
    woo: {
      images: imagePlan,
      creations: finalCreations,
      refs,
      stats,
      rowTypes,
      ignoredColumns: columns.ignored,
      blockedColumns: columns.blocked,
    },
  };
}

/** SKU-urile și ID-urile din fișier (și țintele relațiilor), ca să se încarce din catalog doar ce trebuie. */
export function collectWooLookups(table: ParsedTable): {
  skus: string[];
  legacyIds: string[];
  imageHashes: string[];
} {
  const columns = detectWooColumns(table.headers);
  const cell = (cells: readonly string[], role: WooRole): string => {
    const index = columns.roles[role];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const skus = new Set<string>();
  const legacyIds = new Set<string>();
  const imageHashes = new Set<string>();
  for (const cells of table.rows) {
    const id = cell(cells, "id");
    const sku = cell(cells, "sku");
    if (sku) skus.add(sku);
    else if (id) skus.add(`WC-${id}`);
    if (id) legacyIds.add(id);
    for (const raw of splitImageCell(cell(cells, "images"))) {
      const parsed = parseImageUrl(raw, 4000);
      if (parsed.ok) imageHashes.add(parsed.sourceHash);
    }
    for (const role of ["upsells", "crossSells"] as const) {
      for (const token of splitWooList(cell(cells, role))) {
        const idRef = /^id:(\d+)$/i.exec(token);
        if (idRef) legacyIds.add(idRef[1] as string);
        else skus.add(token);
      }
    }
  }
  return { skus: [...skus], legacyIds: [...legacyIds], imageHashes: [...imageHashes] };
}
