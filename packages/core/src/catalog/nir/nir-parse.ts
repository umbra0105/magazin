import { DomainError, exactFraction, roundHalfUp } from "@ecom/shared";
import { MAX_MONEY } from "../product-schemas";

/**
 * Citirea fișierului de mișcări de produse din SmartBill («lista de mișcări produse»), pentru importul prețurilor de achiziție
 * (NIR, Faza 15, decizii 2026-11-24). Funcții PURE: primesc o grilă de texte (din .xls/.xlsx sau CSV), nu știu de baza de date.
 *
 * Formatul (din exportul real, folosit doar ca referință): rânduri de titlu, apoi antetul (rândul cu «Gestiune», «Produs», «Cod»,
 * «Data»), rânduri de date, un rând final «Total». Coloane: Gestiune | Produs | Cod | Data | Tip document | Document | U.M. |
 * Intrari | Iesiri | Cost unitar | Intrari (valoare) | Iesiri (valoare). Antetul se caută după NUME, nu după poziție.
 *
 * ⚠️ Costul unitar e NET (fără TVA) și ajunge aici ca TEXT zecimal: nu trece niciodată prin `float`. Mesajele de eroare nu repetă
 * valori din fișier (nici costuri, nici coduri).
 */

export class NirFileError extends DomainError {}

export interface NirGridCell {
  /** Textul exact al celulei; `null` = goală. */
  text: string | null;
  /** Ca `text`, cu zerourile din față păstrate la coduri numerice. */
  display: string | null;
  /** O celulă care e o dată calendaristică reală (nu text). */
  date: { year: number; month: number; day: number } | null;
}

export interface NirGridRow {
  /** Numărul rândului în fișier, de la 1. */
  rowNumber: number;
  cells: readonly NirGridCell[];
}

export interface NirRawRow {
  rowNumber: number;
  warehouse: string | null;
  product: string | null;
  code: string | null;
  /** Celula datei, așa cum e: text sau dată calendaristică reală. */
  date: Pick<NirGridCell, "text" | "date">;
  docType: string | null;
  unit: string | null;
  /** «Intrari»: cantitatea intrată, ca text zecimal. */
  qtyIn: string | null;
  /** «Cost unitar», ca text zecimal. */
  unitCost: string | null;
}

export interface NirTable {
  headerRow: number;
  rows: NirRawRow[];
  counters: { dataRows: number; blankRows: number; totalRows: number };
}

const HEADER_SCAN_ROWS = 60;

/** Text de antet comparabil: fără diacritice, litere mici, fără puncte, spații comprimate. */
export function headerKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Field = "warehouse" | "product" | "code" | "date" | "docType" | "unit" | "qtyIn" | "unitCost";

const FIELDS: ReadonlyArray<{
  field: Field;
  label: string;
  aliases: readonly string[];
  /** Coloana trebuie să existe pentru ca importul să poată merge. */
  required: boolean;
  /** Face parte din semnătura care identifică antetul. */
  signature: boolean;
}> = [
  {
    field: "warehouse",
    label: "Gestiune",
    aliases: ["gestiune"],
    required: false,
    signature: true,
  },
  { field: "product", label: "Produs", aliases: ["produs"], required: false, signature: true },
  { field: "code", label: "Cod", aliases: ["cod", "cod produs"], required: true, signature: true },
  { field: "date", label: "Data", aliases: ["data"], required: true, signature: true },
  {
    field: "docType",
    label: "Tip document",
    aliases: ["tip document"],
    required: false,
    signature: false,
  },
  {
    field: "unit",
    label: "U.M.",
    aliases: ["um", "u m", "unitate de masura"],
    required: true,
    signature: false,
  },
  { field: "qtyIn", label: "Intrari", aliases: ["intrari"], required: true, signature: false },
  {
    field: "unitCost",
    label: "Cost unitar",
    aliases: ["cost unitar"],
    required: true,
    signature: false,
  },
];

interface Header {
  index: number;
  columns: Partial<Record<Field, number>>;
}

function findHeader(rows: readonly NirGridRow[]): Header {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index]?.cells ?? [];
    const matches = new Map<Field, number[]>();
    cells.forEach((cell, column) => {
      if (cell.text === null) return;
      const key = headerKey(cell.text);
      for (const spec of FIELDS) {
        if (spec.aliases.includes(key)) {
          matches.set(spec.field, [...(matches.get(spec.field) ?? []), column]);
        }
      }
    });
    const signature = FIELDS.filter((spec) => spec.signature);
    if (!signature.every((spec) => matches.has(spec.field))) continue;

    const missing = FIELDS.filter((spec) => spec.required && !matches.has(spec.field)).map(
      (spec) => spec.label,
    );
    if (missing.length > 0) {
      throw new NirFileError(
        "NIR_FILE_COLUMNS_MISSING",
        `Antetul fișierului nu are coloanele: ${missing.join(", ")}.`,
        { missing, headerRow: rows[index]?.rowNumber ?? index + 1 },
      );
    }
    const repeated = FIELDS.filter((spec) => (matches.get(spec.field)?.length ?? 0) > 1).map(
      (spec) => spec.label,
    );
    if (repeated.length > 0) {
      throw new NirFileError(
        "NIR_FILE_COLUMNS_AMBIGUOUS",
        `Antetul fișierului are de mai multe ori coloana: ${repeated.join(", ")}. Lasă o singură coloană de fiecare fel.`,
        { columns: repeated, headerRow: rows[index]?.rowNumber ?? index + 1 },
      );
    }
    const columns: Partial<Record<Field, number>> = {};
    for (const spec of FIELDS) {
      const column = matches.get(spec.field)?.[0];
      if (column !== undefined) columns[spec.field] = column;
    }
    return { index, columns };
  }
  throw new NirFileError(
    "NIR_FILE_HEADER_NOT_FOUND",
    `Nu am găsit antetul fișierului (coloanele «Gestiune», «Produs», «Cod» și «Data») în primele ${HEADER_SCAN_ROWS} de rânduri. Folosește exportul «mișcări produse» din SmartBill sau șablonul din această pagină.`,
  );
}

const textAt = (cells: readonly NirGridCell[], column: number | undefined, display = false) => {
  if (column === undefined) return null;
  const cell = cells[column];
  if (!cell) return null;
  const value = display ? cell.display : cell.text;
  return value === null ? null : value.trim() === "" ? null : value.trim();
};

/** Tabelul de mișcări din grilă: antetul după nume, rândurile de date, fără rândurile goale și fără «Total». */
export function parseNirTable(grid: readonly NirGridRow[]): NirTable {
  const header = findHeader(grid);
  const rows: NirRawRow[] = [];
  const counters = { dataRows: 0, blankRows: 0, totalRows: 0 };
  for (let index = header.index + 1; index < grid.length; index += 1) {
    const row = grid[index] as NirGridRow;
    const cells = row.cells;
    const c = header.columns;
    const code = textAt(cells, c.code, true);
    const dateCell = c.date === undefined ? undefined : cells[c.date];
    const parsed: NirRawRow = {
      rowNumber: row.rowNumber,
      warehouse: textAt(cells, c.warehouse, true),
      product: textAt(cells, c.product),
      code,
      date: { text: dateCell?.text?.trim() || null, date: dateCell?.date ?? null },
      docType: textAt(cells, c.docType),
      unit: textAt(cells, c.unit, true),
      qtyIn: textAt(cells, c.qtyIn),
      unitCost: textAt(cells, c.unitCost),
    };
    const blank =
      parsed.warehouse === null &&
      parsed.product === null &&
      parsed.code === null &&
      parsed.date.text === null &&
      parsed.date.date === null &&
      parsed.unit === null &&
      parsed.qtyIn === null &&
      parsed.unitCost === null;
    if (blank) {
      counters.blankRows += 1;
      continue;
    }
    // rândul «Total» de la sfârșit: fără cod, cu eticheta «Total» în oricare celulă
    if (
      code === null &&
      cells.some((cell) => cell.text !== null && headerKey(cell.text) === "total")
    ) {
      counters.totalRows += 1;
      continue;
    }
    counters.dataRows += 1;
    rows.push(parsed);
  }
  return { headerRow: grid[header.index]?.rowNumber ?? header.index + 1, rows, counters };
}

// ───────────────────────── date ─────────────────────────

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
  /** `aaaa-ll-zz`, ca text comparabil și serializabil. */
  iso: string;
}

const DATE_TEXT = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

function calendar(year: number, month: number, day: number): CalendarDate | null {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (check.getUTCDate() !== day) return null;
  const two = (value: number) => String(value).padStart(2, "0");
  return { year, month, day, iso: `${year}-${two(month)}-${two(day)}` };
}

/**
 * Data intrării: TEXT `zz/ll/aaaa`, parsare strictă (două cifre pentru zi și lună, patru pentru an, zi care există în calendar).
 * O celulă care e o dată calendaristică reală (nu text) se acceptă la fel, fiindcă e neambiguă. Orice altceva e invalid.
 */
export function parseNirDate(cell: Pick<NirGridCell, "text" | "date">): CalendarDate | null {
  if (cell.date) return calendar(cell.date.year, cell.date.month, cell.date.day);
  if (cell.text === null) return null;
  const match = DATE_TEXT.exec(cell.text.trim());
  if (!match) return null;
  return calendar(Number(match[3]), Number(match[2]), Number(match[1]));
}

// ───────────────────────── numere zecimale ─────────────────────────

export interface DecimalText {
  negative: boolean;
  /** Cifrele fără separator (partea întreagă urmată de zecimale). */
  digits: bigint;
  /** Numărul de zecimale. */
  scale: number;
}

const DECIMAL = /^(-)?(\d{1,18})(?:[.,](\d{1,8}))?$/;

/**
 * Un număr zecimal scris ca text: cifre, cel mult un separator (punct sau virgulă), semn minus opțional. Notația științifică,
 * separatorii de mii și textul se resping (nu se ghicesc). Fără `float`.
 */
export function parseDecimalText(text: string | null): DecimalText | null {
  if (text === null) return null;
  const match = DECIMAL.exec(text.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  return {
    negative: match[1] === "-",
    digits: BigInt(`${match[2]}${fraction}`),
    scale: fraction.length,
  };
}

export const isPositive = (value: DecimalText): boolean => !value.negative && value.digits > 0n;

/**
 * Costul în lei (zecimal) → bani întregi, EXACT: o singură rotunjire, half-up, la 2 zecimale (la bani), prin `Money`.
 * `null` dacă rezultatul e 0, negativ sau peste plafonul unei sume.
 */
export function costToMinor(value: DecimalText): number | null {
  if (value.negative) return null;
  const minor = roundHalfUp(exactFraction(value.digits * 100n, 10n ** BigInt(value.scale)));
  if (minor < 1n || minor > BigInt(MAX_MONEY)) return null;
  return Number(minor);
}
