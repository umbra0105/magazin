import { strFromU8, unzipSync, zipSync } from "fflate";
import { readSheet } from "read-excel-file/universal";
import { DomainError } from "@ecom/shared";
import { XlsxShapeError, assertWorkbookShape } from "./xlsx-bounds";

/**
 * Citirea fișierelor de import (CSV și XLSX) într-un tabel de texte, cu limite stricte:
 *  - **CSV:** parser propriu (RFC 4180: ghilimele, ghilimele duble, linii noi în celule, CRLF/LF/CR),
 *    UTF-16LE cu BOM (formatul scris de aplicație și «Unicode Text» din Excel), UTF-8 cu sau fără BOM (rezervă:
 *    Windows-1250, cu avertisment), delimitator `,` `;` sau tab.
 *  - **XLSX:** doar prima foaie, fără macro-uri, fără evaluarea formulelor (se citește valoarea din
 *    cache, ca în Excel). Arhiva se verifică ÎNAINTE de bibliotecă: pachetul de citire nu limitează
 *    dimensiunea decomprimată, deci `sanitizeXlsx` păstrează doar intrările necesare, cu plafon pe
 *    dimensiunea declarată (fflate trunchiază la ea, deci o dimensiune mincinoasă nu ocolește plafonul),
 *    număr maxim de intrări și total, apoi rearhivează curat.
 *  - Toate celulele devin text; numerele din XLSX păstrează forma lor decimală (fără exponent).
 * Nimic din acest fișier nu atinge baza de date.
 */

export class ImportFileError extends DomainError {}

export type ImportFormat = "csv" | "xlsx";
export type CsvDelimiter = "," | ";" | "\t";
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

export interface ImportLimits {
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
  /** Total decomprimat al intrărilor păstrate dintr-un XLSX. */
  maxUncompressedBytes: number;
  maxZipEntries: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxRows: 5000,
  maxColumns: 200,
  maxCellLength: 100_000,
  maxUncompressedBytes: 60 * 1024 * 1024,
  maxZipEntries: 100,
};

export interface ParsedTable {
  format: ImportFormat;
  /** Doar la CSV. */
  delimiter: CsvDelimiter | null;
  /** De unde vine delimitatorul CSV: linia «sep=», ales explicit sau detectat din antet. */
  delimiterSource: "sep-line" | "chosen" | "detected" | null;
  encoding: "utf-16le" | "utf-8" | "windows-1250" | null;
  headers: string[];
  /** Rândurile de date, fără cele complet goale; fiecare are exact `headers.length` celule. */
  rows: string[][];
  /** Numărul rândului din fișier (antetul e 1) pentru fiecare rând din `rows`. */
  rowNumbers: number[];
  warnings: string[];
}

const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new ImportFileError(code, message, details);
};

/** UTF-16 little-endian cu BOM (FF FE): formatul pe care îl scrie aplicația și pe care îl salvează Excel ca «Unicode Text». */
const isUtf16le = (bytes: Uint8Array): boolean => bytes[0] === 0xff && bytes[1] === 0xfe;

/** Formatul real, din octeți (extensia nu contează). */
export function detectFormat(bytes: Uint8Array): ImportFormat {
  if (bytes.length === 0) return fail("IMPORT_FILE_EMPTY", "Fișierul e gol");
  // ZIP („PK\x03\x04”): XLSX
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "xlsx";
  }
  // OLE2 (D0 CF 11 E0): .xls vechi
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return fail(
      "IMPORT_FILE_UNSUPPORTED",
      "Formatul Excel vechi (.xls) nu e acceptat. Salvează fișierul ca .xlsx sau .csv.",
    );
  }
  // UTF-16 big-endian (FE FF): nu e acceptat (Excel scrie little-endian)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return fail(
      "IMPORT_FILE_UNSUPPORTED",
      "Fișierul e codat UTF-16 big-endian, care nu e acceptat. Salvează-l ca „CSV UTF-8” sau „Unicode Text”.",
    );
  }
  // UTF-16LE cu BOM (FF FE): un CSV, chiar dacă literele ASCII au octeți nuli
  if (isUtf16le(bytes)) return "csv";
  const head = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (head.includes(0)) {
    return fail("IMPORT_FILE_UNSUPPORTED", "Fișierul nu e un CSV sau un XLSX valid.");
  }
  return "csv";
}

/**
 * Windows-1250 nu are ș/ț cu virgulă (U+0219, U+021B, forma corectă în română), ci doar ş/ţ cu sedilă
 * (U+015F, U+0163), pe care Excel le scrie în locul lor. Dintr-un fișier Windows-1250 ele se normalizează
 * la forma corectă, ca titlurile și căutările să nu aibă două variante ale aceleiași litere.
 */
const CEDILLA_TO_COMMA: Readonly<Record<number, string>> = {
  0x15f: String.fromCharCode(0x219),
  0x163: String.fromCharCode(0x21b),
  0x15e: String.fromCharCode(0x218),
  0x162: String.fromCharCode(0x21a),
};

const fixCedillas = (text: string): string =>
  text.replace(/[ŞşŢţ]/g, (char) => CEDILLA_TO_COMMA[char.charCodeAt(0)] ?? char);

/**
 * Text din octeți: UTF-16LE dacă începe cu FF FE (BOM scos; octeți impari sau surogate singure = fișier deteriorat,
 * refuzat); altfel UTF-8 strict (BOM scos); dacă nu e valid, Windows-1250.
 */
export function decodeCsvText(bytes: Uint8Array): {
  text: string;
  encoding: "utf-16le" | "utf-8" | "windows-1250";
} {
  if (isUtf16le(bytes)) {
    try {
      return {
        text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes),
        encoding: "utf-16le",
      };
    } catch {
      return fail(
        "IMPORT_FILE_UNSUPPORTED",
        "Fișierul UTF-16 pare deteriorat (număr impar de octeți sau caractere invalide). Salvează-l din nou ca „CSV UTF-8” sau „Unicode Text”.",
      );
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return {
      text: fixCedillas(new TextDecoder("windows-1250").decode(bytes)),
      encoding: "windows-1250",
    };
  }
}

const SEP_LINE = /^sep=(.)[ \t]*(?:\r\n|\n|\r)/i;

/**
 * Prima linie «sep=<un caracter>» (convenția Excel pentru fișiere CSV: spune ce separator să folosească
 * la deschiderea cu dublu-click, indiferent de setările regionale). Dacă există, e scoasă din text, iar
 * caracterul ei e delimitatorul. Un caracter pe care importul nu îl poate folosi se refuză cu mesaj clar.
 */
export function extractSepLine(text: string): { text: string; delimiter: CsvDelimiter | null } {
  const match = SEP_LINE.exec(text);
  if (!match) return { text, delimiter: null };
  const char = match[1] as string;
  if (!(CSV_DELIMITERS as readonly string[]).includes(char)) {
    return fail(
      "IMPORT_FILE_UNSUPPORTED",
      "Linia «sep=» indică un delimitator pe care importul nu îl acceptă. Folosește virgulă, punct și virgulă sau tab.",
    );
  }
  return { text: text.slice(match[0].length), delimiter: char as CsvDelimiter };
}

/** Delimitatorul cel mai frecvent în primul rând (în afara ghilimelelor); la egalitate, `;` apoi `,`. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  const end = Math.min(text.length, 65_536);
  for (let i = 0; i < end; i++) {
    const ch = text[i] as string;
    if (ch === '"') quoted = !quoted;
    else if (!quoted) {
      if (ch === "\n" || ch === "\r") break;
      if (ch === "," || ch === ";" || ch === "\t") counts[ch]++;
    }
  }
  const order: CsvDelimiter[] = [";", ",", "\t"];
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const delimiter of order) {
    if (counts[delimiter] > bestCount) {
      best = delimiter;
      bestCount = counts[delimiter];
    }
  }
  return best;
}

/**
 * Parser CSV (RFC 4180). Întoarce înregistrările brute (fără tăiere de spații); aruncă la ghilimele
 * neînchise sau la depășirea limitelor. Limita de rânduri se aplică înregistrărilor (antetul + rânduri).
 */
export function parseCsv(text: string, delimiter: CsvDelimiter, limits: ImportLimits): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  const maxRecords = limits.maxRows + 1;

  const endField = () => {
    if (field.length > limits.maxCellLength) {
      fail(
        "IMPORT_FILE_CELL_TOO_LONG",
        `O celulă (rândul ${records.length + 1}) depășește ${limits.maxCellLength} de caractere`,
      );
    }
    record.push(field);
    if (record.length > limits.maxColumns) {
      fail(
        "IMPORT_FILE_TOO_MANY_COLUMNS",
        `Fișierul are mai mult de ${limits.maxColumns} de coloane`,
      );
    }
    field = "";
    fieldStart = true;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    if (records.length > maxRecords) {
      fail(
        "IMPORT_FILE_TOO_MANY_ROWS",
        `Fișierul are mai mult de ${limits.maxRows} de rânduri de date`,
      );
    }
    record = [];
  };

  const length = text.length;
  for (let i = 0; i < length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        field += ch;
        if (field.length > limits.maxCellLength + 1) {
          fail(
            "IMPORT_FILE_CELL_TOO_LONG",
            `O celulă (rândul ${records.length + 1}) depășește ${limits.maxCellLength} de caractere`,
          );
        }
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (inQuotes) {
    fail("IMPORT_FILE_CORRUPT", "Fișierul are ghilimele neînchise; verifică ultimul rând citat");
  }
  // ultima înregistrare, dacă fișierul nu se termină cu linie nouă
  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

const ALLOWED_XLSX_ENTRIES: readonly RegExp[] = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^xl\/workbook\.xml$/,
  /^xl\/_rels\/workbook\.xml\.rels$/,
  /^xl\/worksheets\/[^/]+\.xml$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/styles\.xml$/,
];

/**
 * Verifică și curăță o arhivă XLSX: refuză macro-urile, păstrează doar intrările necesare citirii
 * valorilor, cu plafoane pe număr de intrări și pe dimensiunea decomprimată. Întoarce o arhivă nouă.
 */
export function sanitizeXlsx(bytes: Uint8Array, limits: ImportLimits): Uint8Array {
  let entries = 0;
  let total = 0;
  let macros = false;
  try {
    const kept = unzipSync(bytes, {
      filter(file) {
        entries++;
        if (entries > limits.maxZipEntries) {
          fail(
            "IMPORT_FILE_TOO_LARGE",
            "Arhiva XLSX are prea multe componente; fișierul nu pare un registru Excel obișnuit",
          );
        }
        if (/^xl\/vbaProject/i.test(file.name) || /macroEnabled/i.test(file.name)) macros = true;
        if (!ALLOWED_XLSX_ENTRIES.some((pattern) => pattern.test(file.name))) return false;
        total += file.originalSize;
        if (
          file.originalSize > limits.maxUncompressedBytes ||
          total > limits.maxUncompressedBytes
        ) {
          fail(
            "IMPORT_FILE_TOO_LARGE",
            `Conținutul decomprimat al fișierului XLSX depășește ${Math.round(limits.maxUncompressedBytes / (1024 * 1024))} MB`,
          );
        }
        return true;
      },
    });
    const contentTypes = kept["[Content_Types].xml"];
    if (contentTypes && /macroEnabled|vbaProject/i.test(strFromU8(contentTypes))) macros = true;
    if (macros) {
      fail(
        "IMPORT_FILE_MACROS",
        "Fișierele cu macro-uri (.xlsm) nu sunt acceptate. Salvează registrul ca .xlsx obișnuit.",
      );
    }
    if (!kept["xl/workbook.xml"]) {
      fail("IMPORT_FILE_CORRUPT", "Fișierul XLSX nu are un registru valid (workbook lipsă)");
    }
    // forma foilor (celule departe de date, text expandat, spațiu în exces) ÎNAINTE de biblioteca de citire
    assertWorkbookShape(kept, limits);
    return zipSync(kept, { level: 6 });
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    if (error instanceof XlsxShapeError) throw new ImportFileError(error.code, error.message);
    return fail("IMPORT_FILE_CORRUPT", "Fișierul XLSX nu poate fi citit; pare deteriorat");
  }
}

type RawCell = string | number | boolean | Date | null | undefined;

/** Valoarea unei celule XLSX ca text: număr în formă decimală, dată ISO, boolean „true”/„false”. */
export function cellToText(cell: RawCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (cell instanceof Date)
    return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  if (!Number.isFinite(cell)) return "";
  return String(cell);
}

const stripControl = (value: string): string =>
  // eslint-disable-next-line no-control-regex -- caracterele de control (în afară de tab/linie nouă) nu au loc într-un câmp de produs
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

/** Antet + rânduri de date din înregistrări brute, cu limite, rânduri goale sărite și lățime uniformă. */
function toTable(
  records: readonly (readonly string[])[],
  base: Pick<ParsedTable, "format" | "delimiter" | "delimiterSource" | "encoding" | "warnings">,
  limits: ImportLimits,
): ParsedTable {
  const clean = (value: string): string => stripControl(value).trim();
  const headerRaw = records[0];
  if (!headerRaw) return fail("IMPORT_FILE_EMPTY", "Fișierul nu are niciun rând");
  let width = headerRaw.length;
  while (width > 0 && clean(headerRaw[width - 1] ?? "") === "") width--;
  if (width === 0) return fail("IMPORT_FILE_EMPTY", "Primul rând (antetul) e gol");
  if (width > limits.maxColumns) {
    return fail(
      "IMPORT_FILE_TOO_MANY_COLUMNS",
      `Fișierul are mai mult de ${limits.maxColumns} de coloane`,
    );
  }
  const headers = Array.from({ length: width }, (_, i) => clean(headerRaw[i] ?? ""));
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let index = 1; index < records.length; index++) {
    const record = records[index] as readonly string[];
    const cells = Array.from({ length: width }, (_, i) => clean(record[i] ?? ""));
    if (cells.every((cell) => cell === "")) continue;
    if (cells.some((cell) => cell.length > limits.maxCellLength)) {
      return fail(
        "IMPORT_FILE_CELL_TOO_LONG",
        `O celulă (rândul ${index + 1}) depășește ${limits.maxCellLength} de caractere`,
      );
    }
    rows.push(cells);
    rowNumbers.push(index + 1);
    if (rows.length > limits.maxRows) {
      return fail(
        "IMPORT_FILE_TOO_MANY_ROWS",
        `Fișierul are mai mult de ${limits.maxRows} de rânduri de date`,
      );
    }
  }
  if (rows.length === 0) {
    return fail("IMPORT_FILE_EMPTY", "Fișierul are doar antetul, fără rânduri de date");
  }
  return { ...base, headers, rows, rowNumbers };
}

export interface ParseOptions {
  /** Doar la CSV; lipsă = detectat din primul rând. */
  delimiter?: CsvDelimiter;
}

/** Citește un fișier de import (formatul se stabilește din octeți) într-un tabel de texte. */
export async function parseImportFile(
  bytes: Uint8Array,
  limits: ImportLimits,
  options: ParseOptions = {},
): Promise<ParsedTable> {
  const format = detectFormat(bytes);
  if (format === "csv") {
    const decoded = decodeCsvText(bytes);
    const { encoding } = decoded;
    const sep = extractSepLine(decoded.text);
    const text = sep.text;
    // alegerea explicită a administratorului bate linia «sep=», care bate detectarea
    const delimiter = options.delimiter ?? sep.delimiter ?? detectDelimiter(text);
    const delimiterSource = options.delimiter ? "chosen" : sep.delimiter ? "sep-line" : "detected";
    const warnings =
      encoding === "windows-1250"
        ? [
            "Fișierul nu e UTF-8; l-am citit ca Windows-1250. Verifică diacriticele în previzualizare sau salvează-l ca „CSV UTF-8”.",
          ]
        : [];
    return toTable(
      parseCsv(text, delimiter, limits),
      { format, delimiter, delimiterSource, encoding, warnings },
      limits,
    );
  }

  const clean = sanitizeXlsx(bytes, limits);
  let sheet: RawCell[][];
  try {
    const buffer = clean.buffer.slice(clean.byteOffset, clean.byteOffset + clean.byteLength);
    sheet = (await readSheet(buffer as ArrayBuffer)) as RawCell[][];
  } catch {
    return fail("IMPORT_FILE_CORRUPT", "Fișierul XLSX nu poate fi citit; pare deteriorat");
  }
  if (sheet.length > limits.maxRows + 1) {
    return fail(
      "IMPORT_FILE_TOO_MANY_ROWS",
      `Fișierul are mai mult de ${limits.maxRows} de rânduri de date`,
    );
  }
  const records = sheet.map((row) => {
    if (row.length > limits.maxColumns * 2) {
      return fail(
        "IMPORT_FILE_TOO_MANY_COLUMNS",
        `Fișierul are mai mult de ${limits.maxColumns} de coloane`,
      );
    }
    return row.map(cellToText);
  });
  return toTable(
    records,
    { format, delimiter: null, delimiterSource: null, encoding: null, warnings: [] },
    limits,
  );
}
