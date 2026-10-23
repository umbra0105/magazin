/**
 * Logica pură a formularului «Ajustează» (fără componente): sensul permis de motiv, validarea cantității (fără semn: sensul
 * se alege separat) și textul trimis la server. Serverul rămâne autoritatea și validează din nou (motiv, semn, precizia
 * unității, sub zero, ora efectivă); aici doar dăm un mesaj în română înainte de trimitere.
 */

/** Regula de semn a unui motiv (oglindește `ADJUSTMENT_SIGN_RULES` din nucleu; vine ca prop de pe server). */
export type SignRule = "decrease" | "increase" | "either";
export type AdjustDirection = "add" | "subtract";

export function allowedDirections(rule: SignRule): AdjustDirection[] {
  if (rule === "decrease") return ["subtract"];
  if (rule === "increase") return ["add"];
  return ["subtract", "add"];
}

/** Sensul de folosit după schimbarea motivului: cel curent dacă e permis, altfel primul permis. */
export function directionFor(rule: SignRule, current: AdjustDirection): AdjustDirection {
  const allowed = allowedDirections(rule);
  return allowed.includes(current) ? current : (allowed[0] as AdjustDirection);
}

export type AmountResult =
  | { ok: true; normalized: string }
  | { ok: false; error: "required" | "invalid" | "zero" | "decimals" };

const AMOUNT = /^[0-9]+(?:[.,][0-9]+)?$/;
const MAX_AMOUNT_LENGTH = 40;

/** Cantitatea tastată (număr pozitiv, virgulă sau punct), în limita zecimalelor unității. Zerourile de la coadă nu contează. */
export function validateAmount(text: string, decimals: number): AmountResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "required" };
  if (trimmed.length > MAX_AMOUNT_LENGTH || !AMOUNT.test(trimmed)) {
    return { ok: false, error: "invalid" };
  }
  const [whole = "", fraction = ""] = trimmed.split(/[.,]/);
  if (/^0*$/.test(whole + fraction)) return { ok: false, error: "zero" };
  if (fraction.replace(/0+$/, "").length > decimals) return { ok: false, error: "decimals" };
  return { ok: true, normalized: trimmed };
}

/** Textul cu semn trimis la server (`+2,5` / `-3`). */
export function composeQuantity(direction: AdjustDirection, amount: string): string {
  return `${direction === "add" ? "+" : "-"}${amount}`;
}
