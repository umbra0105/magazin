/**
 * Numere zecimale exacte pentru valorile numerice ale atributelor (coloana `NUMERIC(18,4)`), fără
 * `float`: se lucrează pe șirul de cifre. Se acceptă virgulă sau punct, spații ca separator de mii,
 * semn opțional și cel mult 4 zecimale. Rezultatul e forma canonică cu punct („12.5”, „-3”), pe care
 * baza de date o stochează exact.
 */

/** Zecimale păstrate (scala coloanei). */
export const DECIMAL_SCALE = 4;
/** Cifre înainte de virgulă (precizia 18 minus scala 4). */
export const DECIMAL_INTEGER_DIGITS = 14;

const PATTERN = new RegExp(
  `^(-?)(\\d{1,${DECIMAL_INTEGER_DIGITS}})(?:[.,](\\d{1,${DECIMAL_SCALE}}))?$`,
);

/**
 * „12,5” / „12.50” / „ 1 299,5 ” → „12.5” / „12.5” / „1299.5”; `null` dacă nu e un număr valid
 * (litere, două separatoare, prea multe zecimale sau prea multe cifre). Zerourile de la coadă și
 * „-0” se normalizează.
 */
export function parseDecimalInput(input: string): string | null {
  const cleaned = input.trim().replace(/\s+/g, "");
  const match = PATTERN.exec(cleaned);
  if (!match) return null;
  const [, sign = "", whole = "0", fraction = ""] = match;
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  const body = decimals === "" ? integer : `${integer}.${decimals}`;
  return body === "0" ? "0" : `${sign}${body}`;
}

/** Forma canonică → text de afișat cu virgulă („12.5” → „12,5”). */
export function formatDecimalDisplay(canonical: string): string {
  return canonical.replace(".", ",");
}
