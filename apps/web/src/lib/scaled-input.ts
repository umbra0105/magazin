/**
 * Conversii pentru câmpurile cu unități scalate din admin (kg → grame cu 3 zecimale, m³ → cm³ cu 6 zecimale): ce tastează adminul
 * (virgulă sau punct) ↔ `int`. Fără `float`: se lucrează pe șirul de cifre, ca la `money-input`.
 */

/** «600», «12,5», «0,001» → întreg scalat (`decimals` zecimale); `null` dacă nu e un număr nenegativ valid sau nu încape în întreg sigur. */
export function parseScaledInput(input: string, decimals: number): number | null {
  const cleaned = input.trim().replace(/\s+/g, "");
  if (!/^\d+([.,]\d*)?$/.test(cleaned)) return null;
  const fractionLength = (cleaned.split(/[.,]/)[1] ?? "").length;
  if (fractionLength < 1 && /[.,]/.test(cleaned)) return null;
  if (fractionLength > decimals) return null;
  const [whole = "0", fraction = ""] = cleaned.split(/[.,]/);
  const scaled = Number(whole + fraction.padEnd(decimals, "0"));
  return Number.isSafeInteger(scaled) ? scaled : null;
}

/** Întreg scalat → text pentru câmp, fără zerouri de prisos: (12500, 3) → «12,5»; (600000, 3) → «600». */
export function formatScaledInput(value: number, decimals: number): string {
  const digits = String(Math.max(0, Math.trunc(value))).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole},${fraction}`;
}
