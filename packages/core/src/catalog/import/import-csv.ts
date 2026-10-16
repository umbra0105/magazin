import type { CsvDelimiter } from "./import-file";

/**
 * Scrierea CSV pentru șablon, rapoarte și export. REGULĂ pentru orice CSV generat de aplicație (inclusiv
 * exportul de produse): începe cu BOM UTF-8 (diacriticele), apoi cu linia «sep=<delimitator>». Excel
 * citește delimitatorul din ea la deschiderea cu dublu-click, indiferent de separatorul de listă din
 * setările regionale ale calculatorului (altfel un fișier cu «;» apare într-o singură coloană pe un
 * calculator cu separatorul «,»). Importul recunoaște și scoate linia (vezi `extractSepLine`).
 *
 * Celulele care încep cu \`=\`, \`+\`, \`-\`, \`@\`, tab sau CR sunt neutralizate cu un apostrof în față
 * (injecție de formule când fișierul se deschide în Excel); \`csvCell\` pune ghilimele când celula
 * conține delimitatorul, ghilimele sau linii noi.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string, delimiter: CsvDelimiter): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  const needsQuotes =
    safe.includes(delimiter) ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r") ||
    safe !== safe.trim();
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvWriteOptions {
  delimiter?: CsvDelimiter;
  /** BOM UTF-8, ca Excel să recunoască diacriticele (implicit da). */
  bom?: boolean;
  /** Linia «sep=», ca Excel să deschidă corect fișierul (implicit da; doar testele o opresc). */
  sep?: boolean;
}

/** Rândurile ca text CSV, cu CRLF între ele: [BOM] [sep=;] rânduri. */
export function toCsv(rows: readonly (readonly string[])[], options: CsvWriteOptions = {}): string {
  const delimiter = options.delimiter ?? ";";
  const body = rows
    .map((row) => row.map((cell) => csvCell(cell, delimiter)).join(delimiter))
    .join("\r\n");
  const bom = options.bom === false ? "" : String.fromCharCode(0xfeff);
  const sep = options.sep === false ? "" : `sep=${delimiter}\r\n`;
  return `${bom}${sep}${body}\r\n`;
}
