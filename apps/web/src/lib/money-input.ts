/**
 * Conversii pentru câmpurile de preț din admin: ce tastează adminul (lei, cu virgulă sau punct) ↔
 * `int` în bani. Fără `float` în calcul: se lucrează pe șirul de cifre. Prețul se stochează BRUT.
 */

/** "199", "199,5", "199.50", " 1 299,00 " → bani (int); `null` dacă nu e o sumă validă (max. 2 zecimale). */
export function parseMoneyInput(input: string): number | null {
  const cleaned = input.trim().replace(/\s+/g, ""); // \s include și spațiul „nu se rupe”
  if (!/^\d+([.,]\d{1,2})?$/.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(/[.,]/);
  const bani = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(bani) ? bani : null;
}

/** Bani → text pentru câmp (fără simbol): 19950 → "199,50". */
export function formatMoneyInput(bani: number): string {
  const sign = bani < 0 ? "-" : "";
  const abs = Math.abs(bani);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Bani → text afișat cu moneda din setări: `formatMoney(19950, "RON", "ro-RO")` → „199,50 RON”. */
export function formatMoney(bani: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(bani / 100);
}
