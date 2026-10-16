import {
  CATEGORY_SEPARATOR,
  EXPORT_READONLY_COLUMNS,
  IMPORT_FIELDS,
  type ImportFieldKey,
} from "../import/import-fields";

/**
 * Rândurile exportului de produse, ca DATE (fără format de fișier): aceleași coloane ca la import
 * (`IMPORT_FIELDS`, aceleași antete în română, în aceeași ordine), apoi două coloane doar pentru citire.
 * Un rând = o variantă (un SKU); câmpurile produsului se repetă pe rândurile variantelor lui, exact cum le
 * așteaptă importul. Prețul de achiziție NU există aici: tipurile de mai jos nu au câmp pentru el, iar
 * interogarea din `export-store.ts` nu îl selectează.
 *
 * Valorile text sunt cele brute: neutralizarea formulelor (`=`, `+`, `-`, `@`) o face scriitorul fișierului
 * (CSV: scriitorul din `import-csv.ts`; XLSX: `export-xlsx.ts`), ca regula să fie într-un singur loc pe format.
 */

export const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "Ciornă",
  active: "Activ",
  archived: "Arhivat",
};

export const SHIPPING_CLASS_LABELS: Readonly<Record<string, string>> = {
  standard: "Standard",
  oversized: "Supradimensionat",
  pallet: "Paletizat",
};

/** O celulă a exportului: text, sumă în bani, număr întreg sau goală. */
export type ExportCell =
  | { kind: "text"; value: string }
  | { kind: "money"; bani: number }
  | { kind: "int"; value: number }
  | { kind: "empty" };

export type ExportRow = readonly ExportCell[];

export interface ExportVariantData {
  sku: string;
  ean: string | null;
  price: number;
  salePrice: number | null;
  warrantyMonths: number | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface ExportProductData {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  slug: string;
  status: string;
  shippingClass: string;
  brandName: string | null;
  /** Calea fiecărei categorii a produsului, categoria principală prima (ex. «Pompe > Pompe de circulație»). */
  categoryPaths: readonly string[];
  updatedAt: Date;
  variants: readonly ExportVariantData[];
}

const text = (value: string | null): ExportCell =>
  value === null || value === "" ? { kind: "empty" } : { kind: "text", value };
const integer = (value: number | null): ExportCell =>
  value === null ? { kind: "empty" } : { kind: "int", value };
const money = (bani: number | null): ExportCell =>
  bani === null ? { kind: "empty" } : { kind: "money", bani };

/** Antetele coloanelor, în ordinea exportului (câmpurile importabile, apoi cele doar pentru citire). */
export function exportHeaders(): string[] {
  return [...IMPORT_FIELDS.map((f) => f.label), ...EXPORT_READONLY_COLUMNS.map((c) => c.label)];
}

/** Câmpurile importabile exportate, în ordinea antetelor (pentru teste și documentație). */
export const EXPORTED_FIELD_KEYS: readonly ImportFieldKey[] = IMPORT_FIELDS.map((f) => f.key);

/**
 * Rândurile unui produs: câte unul pe variantă (un produs fără variante nu are rânduri, nu are SKU după care
 * să-l regăsească importul). `formatTimestamp` pune data modificării în fusul magazinului.
 */
export function productRows(
  product: ExportProductData,
  formatTimestamp: (date: Date) => string,
): ExportRow[] {
  return product.variants.map((variant): ExportRow => {
    const byKey: Record<ImportFieldKey, ExportCell> = {
      sku: text(variant.sku),
      title: text(product.title),
      subtitle: text(product.subtitle),
      description: text(product.description),
      slug: text(product.slug),
      price: money(variant.price),
      salePrice: money(variant.salePrice),
      categories: text(
        product.categoryPaths.length > 0
          ? product.categoryPaths.join(` ${CATEGORY_SEPARATOR} `)
          : null,
      ),
      brand: text(product.brandName),
      ean: text(variant.ean),
      warrantyMonths: integer(variant.warrantyMonths),
      weightGrams: integer(variant.weightGrams),
      lengthMm: integer(variant.lengthMm),
      widthMm: integer(variant.widthMm),
      heightMm: integer(variant.heightMm),
      shippingClass: text(SHIPPING_CLASS_LABELS[product.shippingClass] ?? product.shippingClass),
      status: text(STATUS_LABELS[product.status] ?? product.status),
    };
    return [
      ...IMPORT_FIELDS.map((f) => byKey[f.key]),
      ...EXPORT_READONLY_COLUMNS.map((c): ExportCell =>
        c.key === "productId"
          ? text(product.id)
          : { kind: "text", value: formatTimestamp(product.updatedAt) },
      ),
    ];
  });
}

/** Suma în lei pentru CSV: «1299,00» (virgulă zecimală, două zecimale, fără separator de mii). */
export function formatLei(bani: number): string {
  const whole = Math.floor(bani / 100);
  const cents = String(bani % 100).padStart(2, "0");
  return `${whole},${cents}`;
}

/** Textul unei celule în CSV (neutralizarea formulelor o face scriitorul din `import-csv.ts`). */
export function cellToCsvText(cell: ExportCell): string {
  switch (cell.kind) {
    case "text":
      return cell.value;
    case "money":
      return formatLei(cell.bani);
    case "int":
      return String(cell.value);
    default:
      return "";
  }
}
