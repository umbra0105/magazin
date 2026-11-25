/**
 * Procentele din formularul grupurilor de clienți (Faza 15): text cu cel mult 2 zecimale ↔ puncte de bază (întreg), fără `float`.
 * 12,5 → 1250; „5” → 500. Reducerea e limitată la 100%, adaosul la 1000% (baza de date acceptă până la 10000%).
 */

export type PercentProblem = "required" | "invalid" | "too_big";

export function parsePercentToBps(
  input: string,
  maxPercent: number,
): { ok: true; bps: number } | { ok: false; problem: PercentProblem } {
  const cleaned = input.trim().replace(/\s+/g, "").replace(/%$/, "");
  if (cleaned === "") return { ok: false, problem: "required" };
  const match = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return { ok: false, problem: "invalid" };
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > maxPercent * 100) return { ok: false, problem: "too_big" };
  return { ok: true, bps };
}

/** 500 → „5”; 1250 → „12,5”; 0 → „0”. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole},${fraction}`;
}

export const MAX_DISCOUNT_PERCENT = 100;
export const MAX_MARKUP_PERCENT = 1000;
