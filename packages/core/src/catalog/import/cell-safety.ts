/**
 * Neutralizarea injecției de formule în fișierele de export și restaurarea ei la import.
 *
 * Problema: o celulă de text care începe cu `=`, `+`, `-`, `@`, tab sau CR poate fi interpretată de Excel
 * ca formulă când fișierul se deschide (`=HYPERLINK(...)`, `=cmd|...`). La export, un astfel de text
 * primește un apostrof în față, deci Excel îl arată ca text. Numerele NU trec pe aici (prețurile, dimensiunile
 * și garanția sunt valori numerice, niciodată negative), deci un număr negativ n-ar fi stricat.
 *
 * Reimportul: importul scoate apostroful DOAR când el poate fi cel pus de export, adică atunci când după
 * unul sau mai mulți apostrofi urmează un caracter periculos. Regula e bijectivă pe valori:
 *  - export: dacă valoarea se potrivește cu `'*` + caracter periculos → un apostrof în față;
 *  - import: dacă celula se potrivește cu `'+` + caracter periculos → se scoate UN apostrof.
 * Deci `=SUM(A1)` → `'=SUM(A1)` → `=SUM(A1)`, iar o valoare care începe deja cu apostrof și apoi cu `=`
 * (`'=x`) devine `''=x` și se restaurează exact la `'=x`. Un text obișnuit (`'salut`, `Pompă`) nu se atinge.
 *
 * O valoare restaurată e text literal: `-` restaurat din `'-` NU mai e marcajul de ștergere al importului.
 */

const DANGEROUS = "[=+\\-@\\t\\r]";
const NEEDS_NEUTRALIZING = new RegExp(`^'*${DANGEROUS}`);
const WAS_NEUTRALIZED = new RegExp(`^'+${DANGEROUS}`);

/** Valoarea de text sigură pentru un fișier care se deschide în Excel. */
export function neutralizeCell(value: string): string {
  return NEEDS_NEUTRALIZING.test(value) ? `'${value}` : value;
}

/** Inversa lui `neutralizeCell`; `null` dacă celula nu a fost neutralizată (nu se schimbă nimic). */
export function restoreCell(cell: string): string | null {
  return WAS_NEUTRALIZED.test(cell) ? cell.slice(1) : null;
}

/** Textul unei celule după restaurare (sau neschimbat). */
export function restoredText(cell: string): string {
  return restoreCell(cell) ?? cell;
}
