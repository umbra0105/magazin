/**
 * SINGURA funcție de scriere a fișierelor CSV din aplicație: șablonul de import, raportul de import și
 * (export de produse, la 14b, și după) orice export descărcabil. Testul de arhitectură `csv-generation` pică dacă un fișier
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

import { neutralizeCell } from "./cell-safety";

export const CSV_MIME = "text/csv; charset=utf-8";
const DELIMITER = ";";

function csvCell(value: string): string {
  const safe = neutralizeCell(value);
  const needsQuotes =
    safe.includes(DELIMITER) ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r") ||
    safe !== safe.trim();
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Sfârșitul de rând al fișierelor CSV pentru Excel (CRLF). */
const EOL = String.fromCharCode(13, 10);

const PREFIX = `${String.fromCharCode(0xfeff)}sep=${DELIMITER}${EOL}`;

const csvLine = (row: readonly string[]): string => `${row.map(csvCell).join(DELIMITER)}${EOL}`;

const DOWNLOAD_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": CSV_MIME,
};

/** Rândurile ca text CSV pentru Excel: BOM, «sep=;», apoi rândurile (antetul primul), cu CRLF după fiecare. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${PREFIX}${rows.map(csvLine).join("")}`;
}

/** Descărcarea unui CSV: corpul vine din `toCsv`, ca atașament, fără cache și fără ghicirea tipului. */
export function csvResponse(rows: readonly (readonly string[])[], fileName: string): Response {
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      ...DOWNLOAD_HEADERS,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

/**
 * Descărcarea unui CSV mare, în flux: același prefix (BOM + «sep=;») și aceeași scriere a celulelor ca
 * `toCsv`, dar rândurile se scriu pe măsură ce vin (nu se ține tot fișierul în memorie). Primul rând
 * produs e antetul. Dacă sursa aruncă în timpul fluxului, fluxul se închide cu eroare (descărcarea
 * eșuează în browser, nu rămâne un fișier trunchiat care pare complet); verificările care pot refuza
 * exportul se fac ÎNAINTE de a chema această funcție.
 */
export function csvStreamResponse(
  rows: AsyncIterable<readonly string[]>,
  fileName: string,
): Response {
  const iterator = rows[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (first) controller.enqueue(encoder.encode(PREFIX));
          controller.close();
          return;
        }
        const line = csvLine(next.value);
        controller.enqueue(encoder.encode(first ? `${PREFIX}${line}` : line));
        first = false;
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      // clientul a întrerupt descărcarea: sursa își face curățenia (și înregistrează abandonul)
      await iterator.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...DOWNLOAD_HEADERS,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
