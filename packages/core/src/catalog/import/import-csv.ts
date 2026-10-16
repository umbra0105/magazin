/**
 * SINGURA funcție de scriere a fișierelor CSV din aplicație: șablonul de import, raportul de import și
 * (la 14b și după) orice export descărcabil. Testul de arhitectură `csv-generation` pică dacă un fișier
 * din afara acestui modul își construiește singur un CSV (tip MIME `text/csv`, nume `.csv` într-un antet
 * de descărcare sau `csvCell`).
 *
 * REGULA (Excel pe calculatoarele cu separatorul de listă «,» lipește coloanele unui CSV cu «;»): orice
 * CSV destinat deschiderii în Excel începe cu BOM UTF-8 (diacriticele) și cu prima linie «sep=;»
 * (delimitatorul, citit de Excel la dublu-click), apoi antetul în română. Delimitatorul e mereu «;»;
 * nu există opțiune de a omite BOM-ul sau linia «sep=». Importul recunoaște același prefix.
 *
 * Celulele care încep cu `=`, `+`, `-`, `@`, tab sau CR sunt neutralizate cu un apostrof în față
 * (injecție de formule când fișierul se deschide în Excel); se pun ghilimele când celula conține
 * delimitatorul, ghilimele sau linii noi.
 */

export const CSV_MIME = "text/csv; charset=utf-8";
const DELIMITER = ";";
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  const needsQuotes =
    safe.includes(DELIMITER) ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r") ||
    safe !== safe.trim();
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rândurile ca text CSV pentru Excel: BOM, «sep=;», apoi rândurile (antetul primul), cu CRLF între ele. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const body = rows.map((row) => row.map(csvCell).join(DELIMITER)).join("\r\n");
  return `${String.fromCharCode(0xfeff)}sep=${DELIMITER}\r\n${body}\r\n`;
}

/** Descărcarea unui CSV: corpul vine din `toCsv`, ca atașament, fără cache și fără ghicirea tipului. */
export function csvResponse(rows: readonly (readonly string[])[], fileName: string): Response {
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": CSV_MIME,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
