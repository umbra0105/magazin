import { createHash } from "node:crypto";
import { IntegrationError } from "@ecom/shared";
import type { CellObject, WorkBook, WorkSheet } from "xlsx";

/**
 * Cititorul raportului SmartBill «Rapoarte → Stoc la zi» (.xls sau .xlsx): din octeții fișierului scoate rândurile în
 * forma pe care o așteaptă planul importului (`planStockReport` din `@ecom/core`), fără să știe nimic despre catalog.
 *
 * Singurul loc din proiect care importă parserul (`xlsx`, SheetJS 0.20.3, arhiva din `vendor/` verificată cu hash; vezi
 * testul de arhitectură `spreadsheet-parser`). Parserul rulează DOAR pe server, pe octeți primiți (nu citește căi), cu
 * restricțiile aprobate: fișier de cel mult 5 MB, doar prima foaie, fără formule și fără stiluri, cel mult 20.000 de
 * rânduri. Înainte de parser, fișierul trece prin trei verificări proprii: tipul real (nu extensia: SheetJS ar citi și
 * CSV, HTML sau XML), structura arhivei ZIP (intrări, mărime decomprimată, criptare) și dimensiunea.
 *
 * Reguli de citire:
 * - antetul se caută după numele coloanelor (nu după poziție) în primele 60 de rânduri; coloanele necitite («Produs»,
 *   «Sold final» = valoare la cost, «Stoc minim») nu intră în rezultat;
 * - codul și cantitatea rămân TEXT: un cod numeric își păstrează zerourile din formatul celulei, iar cantitatea e valoarea
 *   exactă a celulei (nu cea rotunjită de formatul afișat), scrisă ca text zecimal; nimic nu trece prin `float`;
 * - rândurile goale și rândul «Total» se sar (cu contor); numărul rândului e cel din Excel (de la 1);
 * - formulele nu se calculează și nu se citesc: contează doar valoarea păstrată în celulă; un text care începe cu «=» este
 *   tot text;
 * - data din titlu se citește DOAR din celula cu eticheta «Data» (nu din data tipăririi); dată invalidă sau două date
 *   diferite = fără dată (se confirmă la încărcare);
 * - mesajele de eroare nu conțin valori din fișier.
 */

export const STOCK_REPORT_MAX_BYTES = 5 * 1024 * 1024;
export const STOCK_REPORT_MAX_SHEET_ROWS = 20_000;

const HEADER_SCAN_ROWS = 60;
const ZIP_MAX_ENTRIES = 2_000;
const ZIP_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface StockReportFileRow {
  /** Numărul rândului în foaie, ca în Excel (de la 1) */
  rowNumber: number;
  warehouse: string | null;
  code: string | null;
  unit: string | null;
  /** Valoarea exactă a celulei, ca text zecimal; `null` = celulă goală */
  quantity: string | null;
}

export interface StockReportFileDate {
  year: number;
  month: number;
  day: number;
}

export interface StockReportFile {
  format: "xls" | "xlsx";
  /** SHA-256 (hex) al octeților fișierului, pentru istoricul pozelor */
  fileHash: string;
  byteLength: number;
  /** Rândul antetului, ca în Excel (de la 1) */
  headerRow: number;
  /** Data din titlul raportului; `null` dacă lipsește sau e ambiguă */
  fileDate: StockReportFileDate | null;
  rows: StockReportFileRow[];
  counters: { dataRows: number; blankRows: number; totalRows: number };
}

export type StockReportFileErrorCode =
  | "STOCK_REPORT_FILE_TOO_LARGE"
  | "STOCK_REPORT_FILE_NOT_SPREADSHEET"
  | "STOCK_REPORT_FILE_UNSAFE"
  | "STOCK_REPORT_FILE_PASSWORD"
  | "STOCK_REPORT_FILE_UNREADABLE"
  | "STOCK_REPORT_FILE_EMPTY"
  | "STOCK_REPORT_FILE_TOO_MANY_ROWS"
  | "STOCK_REPORT_FILE_HEADER_NOT_FOUND"
  | "STOCK_REPORT_FILE_COLUMNS_MISSING"
  | "STOCK_REPORT_FILE_COLUMNS_AMBIGUOUS";

function fail(code: StockReportFileErrorCode, message: string, details?: unknown): never {
  throw new IntegrationError(code, message, details);
}

// ───────────────────────── tipul fișierului și structura arhivei ─────────────────────────

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const NOT_SPREADSHEET =
  "Fișierul nu este un registru Excel (.xls sau .xlsx). Exportă raportul «Stoc la zi» din SmartBill ca Excel și încarcă-l din nou.";

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);

/**
 * Verifică arhiva .xlsx din directorul ei central, FĂRĂ să decomprime nimic: intrările și mărimea declarată după
 * decomprimare sunt limitate (bombă ZIP), intrările criptate și ZIP64 se resping, iar arhiva trebuie să conțină
 * `xl/workbook.xml` (un .docx, .ods sau .xlsb nu trece drept registru).
 */
function inspectXlsxArchive(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Sfârșitul arhivei (EOCD): semnătura 0x06054b50, în ultimii 22 + 65535 de octeți.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);

  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const unsafe = (): never =>
    fail(
      "STOCK_REPORT_FILE_UNSAFE",
      "Fișierul .xlsx are o structură neobișnuită (arhivă cu prea multe părți, cu conținut disproporționat sau protejată) și nu a fost citit. Exportă din nou raportul din SmartBill.",
    );
  if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    unsafe();
  }
  if (entries > ZIP_MAX_ENTRIES) unsafe();
  if (directoryOffset + directorySize > eocd)
    fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);

  const decoder = new TextDecoder("utf-8");
  let position = directoryOffset;
  let declaredTotal = 0;
  let hasWorkbook = false;
  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > eocd || view.getUint32(position, true) !== 0x02014b50) {
      fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);
    }
    const flags = view.getUint16(position + 8, true);
    const declaredSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    if (flags % 2 === 1) unsafe();
    declaredTotal += declaredSize;
    if (declaredTotal > ZIP_MAX_UNCOMPRESSED_BYTES) unsafe();
    const nameStart = position + 46;
    if (nameStart + nameLength > eocd) fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (name === "xl/workbook.xml") hasWorkbook = true;
    position = nameStart + nameLength + extraLength + commentLength;
  }
  if (!hasWorkbook) fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);
}

// ───────────────────────── celule → text ─────────────────────────

interface FormatLibrary {
  is_date(format: string): boolean;
  parse_date_code(value: number): { y: number; m: number; d: number } | null;
}

/** Celulă numerică cu format de dată (formatele ciudate, pe care SheetJS nu le înțelege, nu sunt date). */
function isDateCell(cell: CellObject, formats: FormatLibrary): boolean {
  if (cell.t !== "n" || typeof cell.z !== "string") return false;
  try {
    return formats.is_date(cell.z);
  } catch {
    return false;
  }
}

const two = (value: number): string => String(value).padStart(2, "0");

function cleaned(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Textul unei celule. `keepZeros`: o celulă numerică de cod/gestiune/unitate cu format de felul «00000» își păstrează
 * zerourile din față (textul afișat), cât timp afișarea e doar cifre și are aceeași valoare. Cantitatea nu trece pe aici
 * cu `keepZeros`: ea e mereu valoarea exactă a celulei.
 */
function cellText(
  cell: CellObject | undefined,
  formats: FormatLibrary,
  keepZeros: boolean,
): string | null {
  if (!cell) return null;
  switch (cell.t) {
    case "z":
      return null;
    case "s":
      return typeof cell.v === "string" ? cleaned(cell.v) : null;
    case "b":
      return cell.v === true ? "TRUE" : cell.v === false ? "FALSE" : (cell.w ?? "FALSE");
    case "e":
      return cleaned(cell.w ?? "#EROARE") ?? "#EROARE";
    case "d":
      return cleaned(cell.w ?? String(cell.v ?? ""));
    case "n": {
      if (typeof cell.v !== "number") return null;
      const exact = String(cell.v);
      if (isDateCell(cell, formats)) {
        // O dată în locul unui număr: text zz.ll.aaaa, ca planul să o respingă (nu numărul serial).
        const code = formats.parse_date_code(cell.v);
        return code ? `${two(code.d)}.${two(code.m)}.${code.y}` : exact;
      }
      if (keepZeros && typeof cell.w === "string" && /^\d+$/.test(cell.w)) {
        if (cell.w.replace(/^0+(?=\d)/, "") === exact) return cell.w;
      }
      return exact;
    }
    default:
      return null;
  }
}

// ───────────────────────── antet ─────────────────────────

type Field = "warehouse" | "code" | "unit" | "quantity";

const FIELDS: ReadonlyArray<{ field: Field; label: string; aliases: readonly string[] }> = [
  { field: "warehouse", label: "Gestiune", aliases: ["gestiune"] },
  { field: "code", label: "Cod", aliases: ["cod", "cod produs", "cod articol"] },
  { field: "unit", label: "U.M.", aliases: ["um", "u m", "unitate de masura", "unitate masura"] },
  { field: "quantity", label: "Stoc final", aliases: ["stoc final"] },
];

/** Text de antet comparabil: fără diacritice, litere mici, fără puncte, spații comprimate. */
function headerKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Header {
  index: number;
  columns: Record<Field, number>;
}

function findHeader(
  rows: ReadonlyArray<ReadonlyArray<CellObject | undefined>>,
  formats: FormatLibrary,
): Header {
  let best: { index: number; missing: string[]; found: number } | null = null;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index] ?? [];
    const matches = new Map<Field, number[]>();
    cells.forEach((cell, column) => {
      const text = cellText(cell, formats, false);
      if (text === null) return;
      const key = headerKey(text);
      for (const spec of FIELDS) {
        if (spec.aliases.includes(key)) {
          matches.set(spec.field, [...(matches.get(spec.field) ?? []), column]);
        }
      }
    });
    const missing = FIELDS.filter((spec) => !matches.has(spec.field)).map((spec) => spec.label);
    if (missing.length === 0) {
      const repeated = FIELDS.filter((spec) => (matches.get(spec.field)?.length ?? 0) > 1).map(
        (spec) => spec.label,
      );
      if (repeated.length > 0) {
        fail(
          "STOCK_REPORT_FILE_COLUMNS_AMBIGUOUS",
          `Antetul raportului are de mai multe ori coloana: ${repeated.join(", ")}. Lasă o singură coloană de fiecare fel.`,
          { columns: repeated, headerRow: index + 1 },
        );
      }
      const column = (field: Field): number => matches.get(field)?.[0] ?? -1;
      return {
        index,
        columns: {
          warehouse: column("warehouse"),
          code: column("code"),
          unit: column("unit"),
          quantity: column("quantity"),
        },
      };
    }
    const found = FIELDS.length - missing.length;
    if (found >= 2 && (best === null || found > best.found)) best = { index, missing, found };
  }
  if (best) {
    fail(
      "STOCK_REPORT_FILE_COLUMNS_MISSING",
      `Antetul raportului nu are coloanele: ${best.missing.join(", ")}.`,
      { missing: best.missing, headerRow: best.index + 1 },
    );
  }
  fail(
    "STOCK_REPORT_FILE_HEADER_NOT_FOUND",
    `Nu am găsit antetul raportului (coloanele «Gestiune», «Cod», «U.M.» și «Stoc final») în primele ${HEADER_SCAN_ROWS} de rânduri.`,
  );
}

// ───────────────────────── data din titlu ─────────────────────────

const DATE_WITH_LABEL = /^data\s*:?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/i;
const DATE_ALONE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/;
const LABEL_ALONE = /^data\s*:?$/i;

function calendarDate(year: number, month: number, day: number): StockReportFileDate | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function dateFromMatch(match: RegExpExecArray | null): StockReportFileDate | null {
  if (!match) return null;
  const [day, month, year] = [match[1], match[2], match[3]].map((part) =>
    Number.parseInt(part ?? "", 10),
  );
  return calendarDate(year ?? 0, month ?? 0, day ?? 0);
}

function dateFromCell(
  cell: CellObject | undefined,
  formats: FormatLibrary,
): StockReportFileDate | null {
  if (!cell) return null;
  if (typeof cell.v === "number" && isDateCell(cell, formats)) {
    const code = formats.parse_date_code(cell.v);
    return code ? calendarDate(code.y, code.m, code.d) : null;
  }
  const text = cellText(cell, formats, false);
  return text === null ? null : dateFromMatch(DATE_ALONE.exec(text));
}

/** Data din rândurile de DEASUPRA antetului, doar din celula cu eticheta «Data». */
function readFileDate(
  rows: ReadonlyArray<ReadonlyArray<CellObject | undefined>>,
  headerIndex: number,
  formats: FormatLibrary,
): StockReportFileDate | null {
  const found = new Map<string, StockReportFileDate>();
  for (let index = 0; index < headerIndex; index += 1) {
    const cells = rows[index] ?? [];
    cells.forEach((cell, column) => {
      const text = cellText(cell, formats, false);
      if (text === null) return;
      let date = dateFromMatch(DATE_WITH_LABEL.exec(text));
      if (!date && LABEL_ALONE.test(text)) {
        const next = cells
          .slice(column + 1)
          .find((candidate) => cellText(candidate, formats, false) !== null);
        date = dateFromCell(next, formats);
      }
      if (date) found.set(`${date.year}-${date.month}-${date.day}`, date);
    });
  }
  return found.size === 1 ? ([...found.values()][0] ?? null) : null;
}

// ───────────────────────── citirea ─────────────────────────

export async function readStockReportFile(
  input: Uint8Array | ArrayBuffer,
): Promise<StockReportFile> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > STOCK_REPORT_MAX_BYTES) {
    fail(
      "STOCK_REPORT_FILE_TOO_LARGE",
      `Fișierul are peste ${STOCK_REPORT_MAX_BYTES / (1024 * 1024)} MB. Raportul «Stoc la zi» încape cu mult sub această limită: verifică dacă ai ales fișierul potrivit.`,
      { maxBytes: STOCK_REPORT_MAX_BYTES },
    );
  }
  let format: "xls" | "xlsx";
  if (startsWith(bytes, OLE_MAGIC)) {
    format = "xls";
  } else if (startsWith(bytes, ZIP_MAGIC)) {
    format = "xlsx";
    inspectXlsxArchive(bytes);
  } else {
    fail("STOCK_REPORT_FILE_NOT_SPREADSHEET", NOT_SPREADSHEET);
  }

  const XLSX = await import("xlsx");
  const formats = XLSX.SSF as FormatLibrary;
  let workbook: WorkBook;
  try {
    workbook = XLSX.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      type: "buffer",
      cellFormula: false,
      cellStyles: false,
      cellHTML: false,
      cellNF: true,
      cellText: true,
      cellDates: false,
      dense: true,
      sheets: 0,
      sheetRows: STOCK_REPORT_MAX_SHEET_ROWS + 1,
    });
  } catch (error) {
    if (error instanceof Error && /password/i.test(error.message)) {
      fail(
        "STOCK_REPORT_FILE_PASSWORD",
        "Fișierul este protejat cu parolă. Salvează-l fără parolă și încarcă-l din nou.",
      );
    }
    return fail(
      "STOCK_REPORT_FILE_UNREADABLE",
      "Fișierul nu a putut fi citit; poate fi stricat sau incomplet. Exportă din nou raportul din SmartBill.",
    );
  }

  const sheetName = workbook.SheetNames[0];
  const sheet: WorkSheet | undefined =
    sheetName === undefined ? undefined : workbook.Sheets[sheetName];
  const rows: Array<Array<CellObject | undefined>> = sheet?.["!data"] ?? [];
  // Parserul citește cel mult MAX + 1 rânduri: un rând în plus față de limită înseamnă foaie prea mare.
  if (rows.length > STOCK_REPORT_MAX_SHEET_ROWS) {
    fail(
      "STOCK_REPORT_FILE_TOO_MANY_ROWS",
      `Prima foaie are mai mult de ${STOCK_REPORT_MAX_SHEET_ROWS} de rânduri; raportul «Stoc la zi» nu ar trebui să fie atât de mare.`,
      { maxRows: STOCK_REPORT_MAX_SHEET_ROWS },
    );
  }
  const hasContent = rows.some((cells) =>
    (cells ?? []).some((cell) => cellText(cell, formats, false) !== null),
  );
  if (!hasContent) fail("STOCK_REPORT_FILE_EMPTY", "Prima foaie a fișierului este goală.");

  const header = findHeader(rows, formats);
  const fileDate = readFileDate(rows, header.index, formats);

  const result: StockReportFileRow[] = [];
  const counters = { dataRows: 0, blankRows: 0, totalRows: 0 };
  for (let index = header.index + 1; index < rows.length; index += 1) {
    const cells = rows[index] ?? [];
    const warehouse = cellText(cells[header.columns.warehouse], formats, true);
    const code = cellText(cells[header.columns.code], formats, true);
    const unit = cellText(cells[header.columns.unit], formats, true);
    const quantity = cellText(cells[header.columns.quantity], formats, false);
    if (warehouse === null && code === null && unit === null && quantity === null) {
      counters.blankRows += 1;
      continue;
    }
    if (code === null && warehouse !== null && headerKey(warehouse) === "total") {
      counters.totalRows += 1;
      continue;
    }
    counters.dataRows += 1;
    result.push({ rowNumber: index + 1, warehouse, code, unit, quantity });
  }

  return {
    format,
    fileHash: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    headerRow: header.index + 1,
    fileDate,
    rows: result,
    counters,
  };
}
