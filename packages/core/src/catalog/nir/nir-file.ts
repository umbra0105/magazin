import { createHash } from "node:crypto";
import { STOCK_REPORT_MAX_BYTES, readSpreadsheetGrid } from "@ecom/integrations";
import {
  DEFAULT_IMPORT_LIMITS,
  decodeCsvText,
  detectDelimiter,
  extractSepLine,
  parseCsv,
} from "../import/import-file";
import { NirFileError, type NirGridRow } from "./nir-parse";

/**
 * Fișierul de import al prețurilor NIR → grilă de celule. Același mecanism de citire ca la importul «Stoc la zi» pentru
 * `.xls` / `.xlsx` (`readSpreadsheetGrid`, singurul loc care atinge parserul de registre; fără bibliotecă nouă) și aceeași citire
 * de CSV ca la celelalte importuri: UTF-16LE cu BOM și TAB (formatul aplicației și «Unicode Text» din Excel), UTF-8 cu sau fără
 * BOM, Windows-1250 din Excel, linia de separator a fișierelor străine; delimitatorul `;` `,` sau TAB se detectează.
 * Mesajele de eroare nu conțin valori din fișier.
 */

export const NIR_FILE_MAX_BYTES = STOCK_REPORT_MAX_BYTES;
export const NIR_FILE_MAX_ROWS = 20_000;

export interface NirFile {
  format: "csv" | "xls" | "xlsx";
  /** SHA-256 (hex) al octeților. */
  fileHash: string;
  byteLength: number;
  grid: NirGridRow[];
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);

const SHEET_ERRORS: Readonly<Record<string, string>> = {
  STOCK_REPORT_FILE_TOO_LARGE:
    "Fișierul depășește 5 MB. Exportul «mișcări produse» încape cu mult sub această limită.",
  STOCK_REPORT_FILE_NOT_SPREADSHEET:
    "Fișierul nu este un registru Excel (.xls sau .xlsx) valid. Exportă «mișcări produse» din SmartBill ca Excel sau folosește șablonul.",
  STOCK_REPORT_FILE_UNSAFE:
    "Fișierul .xlsx are o structură neobișnuită (arhivă cu prea multe părți, cu conținut disproporționat sau protejată) și nu a fost citit.",
  STOCK_REPORT_FILE_PASSWORD:
    "Fișierul este protejat cu parolă. Salvează-l fără parolă și încarcă-l din nou.",
  STOCK_REPORT_FILE_UNREADABLE:
    "Fișierul nu a putut fi citit; poate fi stricat sau incomplet. Exportă-l din nou din SmartBill.",
  STOCK_REPORT_FILE_EMPTY: "Prima foaie a fișierului este goală.",
  STOCK_REPORT_FILE_TOO_MANY_ROWS: `Prima foaie are mai mult de ${NIR_FILE_MAX_ROWS} de rânduri.`,
};

/** Citește fișierul (formatul se stabilește din octeți, nu din extensie). */
export async function readNirFile(bytes: Uint8Array): Promise<NirFile> {
  if (bytes.byteLength === 0) throw new NirFileError("NIR_FILE_EMPTY", "Fișierul e gol.");
  if (bytes.byteLength > NIR_FILE_MAX_BYTES) {
    throw new NirFileError(
      "NIR_FILE_TOO_LARGE",
      SHEET_ERRORS["STOCK_REPORT_FILE_TOO_LARGE"] as string,
    );
  }
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  if (startsWith(bytes, OLE_MAGIC) || startsWith(bytes, ZIP_MAGIC)) {
    try {
      const sheet = await readSpreadsheetGrid(bytes);
      return {
        format: sheet.format,
        fileHash,
        byteLength: bytes.byteLength,
        grid: sheet.rows.map((row) => ({ rowNumber: row.rowNumber, cells: row.cells })),
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = typeof code === "string" ? SHEET_ERRORS[code] : undefined;
      if (message)
        throw new NirFileError(
          code === "STOCK_REPORT_FILE_TOO_LARGE" ? "NIR_FILE_TOO_LARGE" : "NIR_FILE_UNREADABLE",
          message,
        );
      throw error;
    }
  }

  // CSV (UTF-16LE cu BOM, UTF-8, Windows-1250)
  try {
    const decoded = decodeCsvText(bytes);
    const sep = extractSepLine(decoded.text);
    const delimiter = sep.delimiter ?? detectDelimiter(sep.text);
    const records = parseCsv(sep.text, delimiter, {
      ...DEFAULT_IMPORT_LIMITS,
      maxRows: NIR_FILE_MAX_ROWS,
    });
    // linia de separator scoasă nu mai e în înregistrări, dar în fișier ocupă rândul 1
    const offset = sep.delimiter ? 1 : 0;
    const grid = records.map((record, index): NirGridRow => ({
      rowNumber: index + 1 + offset,
      cells: record.map((value) => {
        const text = value.trim() === "" ? null : value.trim();
        return { text, display: text, date: null };
      }),
    }));
    if (!grid.some((row) => row.cells.some((cell) => cell.text !== null))) {
      throw new NirFileError("NIR_FILE_EMPTY", "Fișierul nu conține date.");
    }
    return { format: "csv", fileHash, byteLength: bytes.byteLength, grid };
  } catch (error) {
    if (error instanceof NirFileError) throw error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("IMPORT_FILE_")) {
      // mesajele cititorului de CSV nu conțin valori din fișier (doar limite și coduri)
      throw new NirFileError("NIR_FILE_UNREADABLE", (error as Error).message);
    }
    throw error;
  }
}
