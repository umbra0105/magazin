/**
 * SINGURA funcție de scriere a fișierelor CSV din aplicație: șablonul de import, raportul de import și
 * (export de produse, la 14b, și după) orice export descărcabil. Testul de arhitectură `csv-generation` pică dacă un fișier
 * din afara acestui modul își construiește singur un CSV (tip MIME `text/csv`, nume `.csv` într-un antet
 * de descărcare sau `csvCell`).
 *
 * FORMATUL (verificat în Excel 16.0 pe Windows, `scripts/excel-csv-probe.ps1`): UTF-16LE cu BOM (octeții FF FE),
 * delimitator TAB, antetul în română de la prima linie, CRLF după fiecare rând, FĂRĂ linia «sep=».
 * De ce nu UTF-8 + «sep=;»: la dublu-click, Excel ignoră BOM-ul UTF-8 dacă prima linie e «sep=…» și citește
 * diacriticele ca Windows-1252 («Adresă» devine «AdresÄƒ»). Fără «sep=», un CSV UTF-8 cu «;» are coloanele
 * lipite pe un PC cu separatorul de listă «,», iar UTF-8 + TAB nu e recunoscut ca TAB. UTF-16LE + BOM + TAB e
 * singura combinație care dă diacritice corecte ȘI coloane separate, indiferent de separatorul de listă
 * (Excel o tratează ca «Unicode Text»). Nu există opțiune de a omite BOM-ul sau de a schimba delimitatorul.
 * Importul acceptă în continuare UTF-8 (cu sau fără BOM), Windows-1250 și linia «sep=» a fișierelor străine.
 *
 * Celulele care încep cu `=`, `+`, `-`, `@`, tab sau CR sunt neutralizate cu un apostrof în față
 * (injecție de formule când fișierul se deschide în Excel); se pun ghilimele când celula conține
 * delimitatorul, ghilimele sau linii noi.
 */

import { neutralizeCell } from "./cell-safety";

export const CSV_MIME = "text/csv; charset=utf-16le";
const DELIMITER = "\t";

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

/** BOM (U+FEFF): scris în UTF-16LE devine octeții FF FE, prin care Excel recunoaște codarea. */
const PREFIX = String.fromCharCode(0xfeff);

const csvLine = (row: readonly string[]): string => `${row.map(csvCell).join(DELIMITER)}${EOL}`;

/** Text → octeți UTF-16LE: fiecare unitate UTF-16 pe 2 octeți, cel mai puțin semnificativ primul. */
function utf16le(text: string): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(text.length * 2);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

const DOWNLOAD_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": CSV_MIME,
};

/** Fișierul CSV pentru Excel, ca octeți: BOM FF FE, apoi rândurile (antetul primul), cu CRLF după fiecare. */
export function toCsv(rows: readonly (readonly string[])[]): Uint8Array<ArrayBuffer> {
  return utf16le(`${PREFIX}${rows.map(csvLine).join("")}`);
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
 * Descărcarea unui CSV mare, în flux: același format (BOM FF FE, TAB, UTF-16LE) și aceeași scriere a celulelor
 * ca `toCsv`, dar rândurile se scriu pe măsură ce vin (nu se ține tot fișierul în memorie); fiecare rând e
 * codat întreg, deci nicio pereche surogat nu se rupe între bucăți. Primul rând
 * produs e antetul. Dacă sursa aruncă în timpul fluxului, fluxul se închide cu eroare (descărcarea
 * eșuează în browser, nu rămâne un fișier trunchiat care pare complet); verificările care pot refuza
 * exportul se fac ÎNAINTE de a chema această funcție.
 */
export function csvStreamResponse(
  rows: AsyncIterable<readonly string[]>,
  fileName: string,
): Response {
  const iterator = rows[Symbol.asyncIterator]();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (first) controller.enqueue(utf16le(PREFIX));
          controller.close();
          return;
        }
        const line = csvLine(next.value);
        controller.enqueue(utf16le(first ? `${PREFIX}${line}` : line));
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
