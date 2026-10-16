import { createHash } from "node:crypto";
import {
  MAX_MONEY,
  productCreateSchema,
  productUpdateSchema,
  variantUpdateSchema,
} from "../product-schemas";
import { PRODUCT_STATUSES, SHIPPING_CLASSES } from "../constants";
import { isValidSlug } from "../slug";
import {
  CATEGORY_PATH_SEPARATOR,
  CATEGORY_SEPARATOR,
  CLEAR_MARKER,
  IMPORT_FIELDS,
  foldText,
  importField,
  isCostLikeHeader,
  isImageHeader,
  type ImportFieldKey,
} from "./import-fields";
import { restoreCell, restoredText } from "./cell-safety";
import type { ParsedTable } from "./import-file";
import type { WooOperation, WooPlanExtras } from "./woo/woo-types";

/**
 * Planificarea unui import: pentru fiecare rând din fișier decide ce s-ar întâmpla (produs nou,
 * actualizare, neschimbat, ignorat, eroare), cu valorile deja normalizate și validate. E o funcție
 * PURĂ pe un tabel + o mapare + un instantaneu al catalogului: nu atinge baza de date, deci aceeași
 * funcție face și verificarea (dry-run), și calculul pentru aplicare. Amprenta planului (hash peste
 * operații) leagă aplicarea de ce a fost verificat.
 *
 * Reguli (documentate pentru administrator în șablon):
 *  - celulă goală = neschimbat; `-` = șterge valoarea, doar la câmpurile care pot fi nule;
 *  - SKU existent pe un produs arhivat sau șters = „ignorat”, nu se actualizează în tăcere;
 *  - categorie sau brand inexistent = eroare pe rând (nu se creează nimic);
 *  - prețurile sunt în lei cu TVA, cel mult 2 zecimale, convertite exact în bani, fără rotunjire.
 */

export interface ImportMapping {
  /** Câmpul fiecărei coloane din fișier, în ordine (`null` = coloană ignorată). */
  columns: readonly (ImportFieldKey | null)[];
}

export interface ExistingVariant {
  variantId: string;
  productId: string;
  sku: string;
  ean: string | null;
  price: number;
  salePrice: number | null;
  warrantyMonths: number | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  product: {
    title: string;
    slug: string;
    subtitle: string | null;
    description: string | null;
    status: string;
    deleted: boolean;
    brandId: string | null;
    shippingClass: string;
    /** Prima e categoria principală. */
    categoryIds: string[];
  };
}

export interface ImportSnapshot {
  /** După SKU, cu minuscule. */
  variantsBySku: ReadonlyMap<string, ExistingVariant>;
  /** Adresele (minuscule) deja folosite, de orice produs (și șters), cu proprietarul. */
  slugOwners: ReadonlyMap<string, string>;
  /** Calea normalizată („pompe>pompe de circulatie”) → id; `null` = ambiguă. */
  categoryIndex: ReadonlyMap<string, string | null>;
  /** Numele normalizat → id; `null` = ambiguu. */
  brandIndex: ReadonlyMap<string, string | null>;
}

export type RowOutcome = "new" | "updated" | "unchanged" | "skipped" | "error";

export interface ImportMessage {
  level: "error" | "warning";
  text: string;
}

export type ImportOperation =
  | { kind: "create"; input: Record<string, unknown> }
  | {
      kind: "update";
      productId: string;
      variantId: string;
      productPatch: Record<string, unknown> | null;
      variantPatch: Record<string, unknown> | null;
      categoryIds: string[] | null;
    }
  /** Operațiile profilului WooCommerce (vezi `woo/woo-types.ts`). */
  | WooOperation;

export interface PlannedRow {
  /** Numărul rândului din fișier (antetul e 1). */
  row: number;
  sku: string;
  outcome: RowOutcome;
  messages: ImportMessage[];
  /** Câmpurile care se schimbă (etichetele din interfață), pentru raport. */
  changed: string[];
  op: ImportOperation | null;
}

export interface ImportCounts {
  new: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  warnings: number;
}

export interface ImportPlan {
  rows: PlannedRow[];
  counts: ImportCounts;
  fileWarnings: string[];
  /** SHA-256 peste operațiile planificate; schimbat dacă fișierul, maparea sau catalogul s-au schimbat. */
  fingerprint: string;
  /** Doar la profilul WooCommerce: ce se creează, id-urile existente referite, statistici. */
  woo?: WooPlanExtras;
}

export class ImportMappingError extends Error {
  constructor(
    readonly code: "IMPORT_MAPPING_COST" | "IMPORT_MAPPING_INVALID",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Indecși din date (căi de categorii, nume de branduri)
// ---------------------------------------------------------------------------

export function categoryKey(names: readonly string[]): string {
  return names.map((n) => foldText(n)).join(CATEGORY_PATH_SEPARATOR);
}

/** Calea fiecărei categorii din arbore (nume de la rădăcină), ca index normalizat; căile duble → `null`. */
export function buildCategoryIndex(
  categories: readonly { id: string; name: string; parentId: string | null }[],
): Map<string, string | null> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const index = new Map<string, string | null>();
  for (const category of categories) {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: typeof category | undefined = category;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    const key = categoryKey(names);
    index.set(key, index.has(key) ? null : category.id);
  }
  return index;
}

export function buildBrandIndex(
  brands: readonly { id: string; name: string }[],
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const brand of brands) {
    const key = foldText(brand.name);
    index.set(key, index.has(key) ? null : brand.id);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Parsarea valorilor
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

const shortValue = (raw: string): string => (raw.length > 30 ? `${raw.slice(0, 30)}…` : raw);

/** „1299”, „1299,5”, „199.90”, „1 299,00”, „199 lei” → bani; fără separator de mii, cel mult 2 zecimale. */
export function parseLeiToBani(raw: string): Parsed<number> {
  const cleaned = raw
    .trim()
    .replace(/\s*(lei|ron)\.?$/i, "")
    .replace(/\s+/g, ""); // \s include și spațiul „nu se rupe”
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    return bad(
      `valoare invalidă „${shortValue(raw)}” (scrie suma în lei, cu virgulă sau punct, cel mult 2 zecimale și fără separator de mii)`,
    );
  }
  const bani = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(bani)) return bad(`valoare prea mare „${shortValue(raw)}”`);
  if (bani < 1) return bad("suma trebuie să fie de cel puțin 0,01 lei");
  if (bani > MAX_MONEY) return bad("suma depășește plafonul de 10.000.000 de lei");
  return ok(bani);
}

function parseInteger(raw: string, min: number, max: number): Parsed<number> {
  const cleaned = raw.replace(/\s+/g, "");
  if (!/^\d+$/.test(cleaned)) return bad(`valoare invalidă „${shortValue(raw)}” (număr întreg)`);
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return bad(`valoarea trebuie să fie între ${min} și ${max}`);
  }
  return ok(value);
}

const ENUM_SHIPPING: Record<string, string> = {
  standard: "standard",
  supradimensionat: "oversized",
  oversized: "oversized",
  paletizat: "pallet",
  pallet: "pallet",
};
const ENUM_STATUS: Record<string, string> = {
  ciorna: "draft",
  draft: "draft",
  activ: "active",
  active: "active",
  arhivat: "archived",
  archived: "archived",
};

function parseEnum(
  raw: string,
  map: Record<string, string>,
  allowed: readonly string[],
): Parsed<string> {
  const value = map[foldText(raw)];
  if (!value || !allowed.includes(value)) {
    return bad(`valoare necunoscută „${shortValue(raw)}”`);
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Planul
// ---------------------------------------------------------------------------

/** Câmpurile unei variante, cu cheia din baza de date. */
const VARIANT_COLUMN: Partial<Record<ImportFieldKey, string>> = {
  price: "price",
  salePrice: "salePrice",
  ean: "ean",
  warrantyMonths: "warrantyMonths",
  weightGrams: "weightGrams",
  lengthMm: "lengthMm",
  widthMm: "widthMm",
  heightMm: "heightMm",
};

const labelOf = (key: ImportFieldKey): string => importField(key).label;

/** Valorile din fișier pe câmp: `undefined` = celulă goală (neschimbat), `null` = marcaj de ștergere. */
type RowValues = Partial<Record<ImportFieldKey, string | null>>;

function readRowValues(
  cells: readonly string[],
  mapping: ImportMapping,
  errors: ImportMessage[],
): RowValues {
  const values: RowValues = {};
  mapping.columns.forEach((field, index) => {
    if (!field) return;
    const raw = (cells[index] ?? "").trim();
    if (raw === "") return;
    // un apostrof pus de export în fața unui text periculos (=, +, -, @) se scoate; valoarea rămâne text
    // literal (un «-» restaurat din «'-» nu mai e marcajul de ștergere)
    const restored = restoreCell(raw);
    if (restored !== null) {
      values[field] = restored;
      return;
    }
    const cell = raw;
    if (cell === CLEAR_MARKER) {
      if (!importField(field).clearable) {
        errors.push({
          level: "error",
          text: `${labelOf(field)}: valoarea nu se poate șterge cu „${CLEAR_MARKER}”`,
        });
        return;
      }
      values[field] = null;
      return;
    }
    values[field] = cell;
  });
  return values;
}

interface ParsedFields {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  slug?: string;
  status?: string;
  brandId?: string | null;
  shippingClass?: string;
  price?: number;
  salePrice?: number | null;
  ean?: string | null;
  warrantyMonths?: number | null;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  categoryIds?: string[];
}

function parseFields(
  values: RowValues,
  snapshot: ImportSnapshot,
  errors: ImportMessage[],
): ParsedFields {
  const out: ParsedFields = {};
  const fail = (field: ImportFieldKey, message: string) =>
    errors.push({ level: "error", text: `${labelOf(field)}: ${message}` });

  for (const field of IMPORT_FIELDS) {
    const key = field.key;
    if (key === "sku" || !(key in values)) continue;
    const raw = values[key];
    switch (key) {
      case "title": {
        const text = raw as string;
        if (text.length > 200) fail(key, "cel mult 200 de caractere");
        else out.title = text;
        break;
      }
      case "subtitle":
        if (raw === null) out.subtitle = null;
        else if ((raw as string).length > 300) fail(key, "cel mult 300 de caractere");
        else out.subtitle = raw as string;
        break;
      case "description":
        out.description = raw === null ? null : (raw as string);
        break;
      case "slug":
        if (!isValidSlug(raw as string)) {
          fail(key, "doar litere mici, cifre și cratime (cel mult 80 de caractere)");
        } else out.slug = raw as string;
        break;
      case "price": {
        const parsed = parseLeiToBani(raw as string);
        if (parsed.ok) out.price = parsed.value;
        else fail(key, parsed.error);
        break;
      }
      case "salePrice": {
        if (raw === null) {
          out.salePrice = null;
          break;
        }
        const parsed = parseLeiToBani(raw as string);
        if (parsed.ok) out.salePrice = parsed.value;
        else fail(key, parsed.error);
        break;
      }
      case "ean":
        if (raw === null) out.ean = null;
        else if (!/^\d{8,14}$/.test(raw as string)) fail(key, "EAN-ul are 8–14 cifre");
        else out.ean = raw as string;
        break;
      case "warrantyMonths":
      case "weightGrams":
      case "lengthMm":
      case "widthMm":
      case "heightMm": {
        if (raw === null) {
          out[key] = null;
          break;
        }
        const range =
          key === "warrantyMonths"
            ? ([0, 240] as const)
            : key === "weightGrams"
              ? ([1, 10_000_000] as const)
              : ([1, 100_000] as const);
        const parsed = parseInteger(raw as string, range[0], range[1]);
        if (parsed.ok) out[key] = parsed.value;
        else fail(key, parsed.error);
        break;
      }
      case "shippingClass": {
        const parsed = parseEnum(raw as string, ENUM_SHIPPING, SHIPPING_CLASSES);
        if (parsed.ok) out.shippingClass = parsed.value;
        else fail(key, `${parsed.error} (Standard, Supradimensionat sau Paletizat)`);
        break;
      }
      case "status": {
        const parsed = parseEnum(raw as string, ENUM_STATUS, PRODUCT_STATUSES);
        if (parsed.ok) out.status = parsed.value;
        else fail(key, `${parsed.error} (Ciornă, Activ sau Arhivat)`);
        break;
      }
      case "brand": {
        if (raw === null) {
          out.brandId = null;
          break;
        }
        const id = snapshot.brandIndex.get(foldText(raw as string));
        if (id === undefined) {
          fail(
            key,
            `brandul „${shortValue(raw as string)}” nu există; creează-l mai întâi în Branduri`,
          );
        } else if (id === null)
          fail(key, `există mai multe branduri numite „${shortValue(raw as string)}”`);
        else out.brandId = id;
        break;
      }
      case "categories": {
        const ids: string[] = [];
        for (const part of (raw as string).split(CATEGORY_SEPARATOR)) {
          const path = part.trim();
          if (path === "") continue;
          const names = path.split(CATEGORY_PATH_SEPARATOR).map((n) => n.trim());
          if (names.some((n) => n === "")) {
            fail(key, `calea „${shortValue(path)}” are un nivel gol`);
            continue;
          }
          const id = snapshot.categoryIndex.get(categoryKey(names));
          if (id === undefined) {
            fail(key, `categoria „${shortValue(path)}” nu există; creeaz-o mai întâi în Categorii`);
          } else if (id === null)
            fail(key, `calea „${shortValue(path)}” se potrivește cu mai multe categorii`);
          else if (!ids.includes(id)) ids.push(id);
        }
        if (ids.length > 0) out.categoryIds = ids;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const issueText = (issue: { path: PropertyKey[]; message: string }): string => {
  const head = issue.path[0] === "variants" ? issue.path[2] : issue.path[0];
  const field = IMPORT_FIELDS.find((f) => f.key === head || VARIANT_COLUMN[f.key] === head);
  return field ? `${field.label}: ${issue.message}` : issue.message;
};

function planNew(
  fields: ParsedFields,
  values: RowValues,
  sku: string,
  errors: ImportMessage[],
  snapshot: ImportSnapshot,
  claimedSlugs: Map<string, number>,
  row: number,
): { op: ImportOperation | null; changed: string[] } {
  const reported = (label: string) => errors.some((e) => e.text.startsWith(label));
  if (fields.title === undefined && !reported("Titlu")) {
    errors.push({
      level: "error",
      text: "Titlu: obligatoriu la un produs nou (SKU negăsit în catalog)",
    });
  }
  if (fields.price === undefined && !reported("Preț")) {
    errors.push({
      level: "error",
      text: "Preț: obligatoriu la un produs nou (SKU negăsit în catalog)",
    });
  }
  if (fields.slug !== undefined) {
    const key = fields.slug.toLowerCase();
    if (snapshot.slugOwners.has(key)) {
      errors.push({
        level: "error",
        text: `Adresă (slug): «${fields.slug}» e deja folosită de alt produs`,
      });
    } else if (claimedSlugs.has(key)) {
      errors.push({
        level: "error",
        text: `Adresă (slug): «${fields.slug}» e folosită și la rândul ${claimedSlugs.get(key)} din fișier`,
      });
    } else claimedSlugs.set(key, row);
  }
  if (errors.some((e) => e.level === "error")) return { op: null, changed: [] };

  const variant: Record<string, unknown> = { sku, price: fields.price, isDefault: true };
  for (const [field, column] of Object.entries(VARIANT_COLUMN)) {
    if (field === "price") continue;
    const value = fields[field as keyof ParsedFields];
    if (value !== undefined) variant[column as string] = value;
  }
  const input: Record<string, unknown> = {
    title: fields.title,
    ...(fields.slug !== undefined && { slug: fields.slug }),
    ...(fields.subtitle !== undefined && { subtitle: fields.subtitle }),
    ...(fields.description !== undefined && { description: fields.description }),
    status: fields.status ?? "draft",
    ...(fields.brandId !== undefined && { brandId: fields.brandId }),
    ...(fields.shippingClass !== undefined && { shippingClass: fields.shippingClass }),
    ...(fields.categoryIds !== undefined && { categoryIds: fields.categoryIds }),
    variants: [variant],
  };
  const checked = productCreateSchema.safeParse(input);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      errors.push({ level: "error", text: issueText(issue) });
    }
    return { op: null, changed: [] };
  }
  void values;
  return {
    op: { kind: "create", input },
    changed: IMPORT_FIELDS.filter((f) => f.key in values || f.key === "sku").map((f) => f.label),
  };
}

function planUpdate(
  fields: ParsedFields,
  existing: ExistingVariant,
  errors: ImportMessage[],
  snapshot: ImportSnapshot,
  productClaims: Map<string, Map<string, { value: unknown; row: number }>>,
  row: number,
): { op: ImportOperation | null; changed: string[] } {
  const product = existing.product;
  const productPatch: Record<string, unknown> = {};
  const variantPatch: Record<string, unknown> = {};
  const changed: string[] = [];

  const same = (a: unknown, b: unknown): boolean => a === b;
  const setProduct = (field: ImportFieldKey, column: string, next: unknown, current: unknown) => {
    if (same(next, current)) return;
    productPatch[column] = next;
    changed.push(labelOf(field));
  };

  if (fields.title !== undefined) setProduct("title", "title", fields.title, product.title);
  if (fields.subtitle !== undefined)
    setProduct("subtitle", "subtitle", fields.subtitle, product.subtitle);
  if (fields.description !== undefined) {
    setProduct("description", "description", fields.description, product.description);
  }
  if (fields.status !== undefined) setProduct("status", "status", fields.status, product.status);
  if (fields.shippingClass !== undefined) {
    setProduct("shippingClass", "shippingClass", fields.shippingClass, product.shippingClass);
  }
  if (fields.brandId !== undefined) setProduct("brand", "brandId", fields.brandId, product.brandId);
  if (fields.slug !== undefined && fields.slug.toLowerCase() !== product.slug.toLowerCase()) {
    const owner = snapshot.slugOwners.get(fields.slug.toLowerCase());
    if (owner !== undefined && owner !== existing.productId) {
      errors.push({
        level: "error",
        text: `Adresă (slug): «${fields.slug}» e deja folosită de alt produs`,
      });
    } else {
      productPatch["slug"] = fields.slug;
      changed.push(labelOf("slug"));
    }
  }

  for (const [field, column] of Object.entries(VARIANT_COLUMN)) {
    const next = fields[field as keyof ParsedFields];
    if (next === undefined) continue;
    const current = existing[column as keyof ExistingVariant];
    if (next !== current) {
      variantPatch[column as string] = next;
      changed.push(labelOf(field as ImportFieldKey));
    }
  }
  // promoția față de prețul rezultat (cel din fișier sau cel curent)
  const priceAfter = (variantPatch["price"] as number | undefined) ?? existing.price;
  const saleAfter =
    "salePrice" in variantPatch ? (variantPatch["salePrice"] as number | null) : existing.salePrice;
  if (saleAfter !== null && saleAfter > priceAfter) {
    errors.push({
      level: "error",
      text: "Preț promoțional: nu poate depăși prețul întreg (cel din fișier sau cel curent)",
    });
  }

  let categoryIds: string[] | null = null;
  if (fields.categoryIds !== undefined) {
    const current = product.categoryIds;
    const sameSet =
      current.length === fields.categoryIds.length &&
      fields.categoryIds.every((id) => current.includes(id));
    if (!sameSet || current[0] !== fields.categoryIds[0]) {
      categoryIds = fields.categoryIds;
      changed.push(labelOf("categories"));
    }
  }

  // același produs modificat de mai multe rânduri (variante) cu valori diferite
  const claims = productClaims.get(existing.productId) ?? new Map();
  productClaims.set(existing.productId, claims);
  for (const [column, value] of Object.entries(productPatch)) {
    const earlier = claims.get(column);
    if (earlier && earlier.value !== value) {
      errors.push({
        level: "error",
        text: `Același produs e modificat și la rândul ${earlier.row} cu altă valoare pentru «${column}»`,
      });
    } else claims.set(column, { value, row });
  }
  if (categoryIds) {
    const earlier = claims.get("categoryIds");
    if (earlier && JSON.stringify(earlier.value) !== JSON.stringify(categoryIds)) {
      errors.push({
        level: "error",
        text: `Același produs are alte categorii la rândul ${earlier.row}`,
      });
    } else claims.set("categoryIds", { value: categoryIds, row });
  }

  if (Object.keys(productPatch).length > 0) {
    const checked = productUpdateSchema.safeParse(productPatch);
    if (!checked.success) {
      for (const issue of checked.error.issues)
        errors.push({ level: "error", text: issueText(issue) });
    }
  }
  if (Object.keys(variantPatch).length > 0) {
    const checked = variantUpdateSchema.safeParse(variantPatch);
    if (!checked.success) {
      for (const issue of checked.error.issues)
        errors.push({ level: "error", text: issueText(issue) });
    }
  }
  if (errors.some((e) => e.level === "error")) return { op: null, changed: [] };
  if (changed.length === 0) return { op: null, changed: [] };
  return {
    op: {
      kind: "update",
      productId: existing.productId,
      variantId: existing.variantId,
      productPatch: Object.keys(productPatch).length > 0 ? productPatch : null,
      variantPatch: Object.keys(variantPatch).length > 0 ? variantPatch : null,
      categoryIds,
    },
    changed,
  };
}

/** SKU-urile și adresele din fișier, ca să se încarce din catalog doar ce trebuie. */
export function collectLookups(
  table: ParsedTable,
  mapping: ImportMapping,
): { skus: string[]; slugs: string[] } {
  const skuColumn = mapping.columns.indexOf("sku");
  const slugColumn = mapping.columns.indexOf("slug");
  const skus = new Set<string>();
  const slugs = new Set<string>();
  for (const cells of table.rows) {
    const sku = skuColumn >= 0 ? restoredText((cells[skuColumn] ?? "").trim()) : "";
    if (sku) skus.add(sku);
    const slug = slugColumn >= 0 ? restoredText((cells[slugColumn] ?? "").trim()) : "";
    if (slug && slug !== CLEAR_MARKER) slugs.add(slug);
  }
  return { skus: [...skus], slugs: [...slugs] };
}

/** Refuză maparea nevalidă: coloane lipsă/în plus, câmp dublat, SKU nemapat, coloană de cost mapată. */
export function assertMappingValid(table: ParsedTable, mapping: ImportMapping): void {
  if (mapping.columns.length !== table.headers.length) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Maparea nu corespunde coloanelor fișierului; reîncarcă pagina",
    );
  }
  const seen = new Set<ImportFieldKey>();
  mapping.columns.forEach((field, index) => {
    if (!field) return;
    const header = table.headers[index] ?? "";
    if (isCostLikeHeader(header)) {
      throw new ImportMappingError(
        "IMPORT_MAPPING_COST",
        `Coloana «${shortValue(header)}» pare să conțină prețul de achiziție sau date de furnizor. Prețul de achiziție nu se importă; lasă coloana nemapată.`,
      );
    }
    if (isImageHeader(header)) {
      throw new ImportMappingError(
        "IMPORT_MAPPING_INVALID",
        `Coloana «${shortValue(header)}» conține imagini; importul de imagini nu face parte din acest import. Lasă coloana nemapată.`,
      );
    }
    if (seen.has(field)) {
      throw new ImportMappingError(
        "IMPORT_MAPPING_INVALID",
        `Câmpul «${labelOf(field)}» e mapat pe mai multe coloane`,
      );
    }
    seen.add(field);
  });
  if (!seen.has("sku")) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Mapează o coloană pe SKU: fără el nu se știe ce produs se actualizează",
    );
  }
  if (seen.size < 2) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Mapează cel puțin o coloană în afară de SKU",
    );
  }
}

export function planImport(
  table: ParsedTable,
  mapping: ImportMapping,
  snapshot: ImportSnapshot,
): ImportPlan {
  assertMappingValid(table, mapping);
  const skuColumn = mapping.columns.indexOf("sku");
  const seenSkus = new Map<string, number>();
  const claimedSlugs = new Map<string, number>();
  const productClaims = new Map<string, Map<string, { value: unknown; row: number }>>();
  const rows: PlannedRow[] = [];

  table.rows.forEach((cells, index) => {
    const row = table.rowNumbers[index] as number;
    const messages: ImportMessage[] = [];
    const sku = restoredText((cells[skuColumn] ?? "").trim());
    const planned = (
      outcome: RowOutcome,
      op: ImportOperation | null = null,
      changed: string[] = [],
    ): PlannedRow => ({ row, sku, outcome, messages, changed, op });

    if (sku === "") {
      messages.push({ level: "error", text: "SKU lipsă" });
      return rows.push(planned("error"));
    }
    if (sku.length > 64) {
      messages.push({ level: "error", text: "SKU: cel mult 64 de caractere" });
      return rows.push(planned("error"));
    }
    const skuKey = sku.toLowerCase();
    const first = seenSkus.get(skuKey);
    if (first !== undefined) {
      messages.push({
        level: "error",
        text: `SKU repetat: apare și la rândul ${first} din fișier`,
      });
      return rows.push(planned("error"));
    }
    seenSkus.set(skuKey, row);

    const errors: ImportMessage[] = [];
    const values = readRowValues(cells, mapping, errors);
    const fields = parseFields(values, snapshot, errors);
    const existing = snapshot.variantsBySku.get(skuKey);

    if (existing && (existing.product.deleted || existing.product.status === "archived")) {
      messages.push({
        level: "warning",
        text: existing.product.deleted
          ? "Ignorat: SKU-ul aparține unui produs din coșul de gunoi; restaurează-l ca să-l poți actualiza"
          : "Ignorat: SKU-ul aparține unui produs arhivat; dezarhivează-l ca să-l poți actualiza",
      });
      return rows.push(planned("skipped"));
    }

    const result = existing
      ? planUpdate(fields, existing, errors, snapshot, productClaims, row)
      : planNew(fields, values, sku, errors, snapshot, claimedSlugs, row);

    messages.push(...errors);
    if (errors.some((e) => e.level === "error")) return rows.push(planned("error"));
    if (!result.op) return rows.push(planned("unchanged"));
    return rows.push(planned(existing ? "updated" : "new", result.op, result.changed));
  });

  const counts: ImportCounts = {
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
  };
  for (const r of rows) {
    if (r.outcome === "new") counts.new++;
    else if (r.outcome === "updated") counts.updated++;
    else if (r.outcome === "unchanged") counts.unchanged++;
    else if (r.outcome === "skipped") counts.skipped++;
    else counts.errors++;
    counts.warnings += r.messages.filter((m) => m.level === "warning").length;
  }

  const fileWarnings = [
    ...table.warnings,
    ...table.headers
      .filter((header) => isImageHeader(header))
      .map(
        (header) =>
          `Coloana «${shortValue(header)}» (imagini) a fost ignorată: importul de imagini nu face parte din acest import.`,
      ),
    ...table.headers
      .filter((header, i) => isCostLikeHeader(header) && !mapping.columns[i])
      .map(
        (header) =>
          `Coloana «${shortValue(header)}» pare de cost sau de furnizor și nu se importă (prețul de achiziție nu se importă niciodată).`,
      ),
  ];

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.row, r.sku, r.outcome, r.op])))
    .digest("hex");
  return { rows, counts, fileWarnings, fingerprint };
}
