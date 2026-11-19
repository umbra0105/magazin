/**
 * Validarea CUI (cod unic de înregistrare fiscală) românesc, LOCAL și mereu: format (2–10 cifre, prefix opțional «RO») și cifra
 * de control. Numele și adresa vin de la ANAF (`cui-verification.ts`), dar o eroare ANAF nu înlocuiește această verificare.
 *
 * Cifra de control: cheia de test 753217532 se aliniază la DREAPTA cu cifrele CUI-ului fără ultima cifră; produsele se adună,
 * suma se înmulțește cu 10, restul la 11 e cifra de control, iar restul 10 devine 0.
 */

const KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2] as const;
const CUI_PATTERN = /^(?:(RO)\s*)?(\d{2,10})$/i;

/** Cifra de control a unui CUI dat FĂRĂ ultima cifră (1–9 cifre). */
export function cuiCheckDigit(body: string): number {
  if (!/^\d{1,9}$/.test(body)) throw new RangeError("Corpul CUI are 1–9 cifre");
  const key = KEY.slice(KEY.length - body.length);
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (key[i] as number);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

export type CuiValidation =
  | { ok: true; digits: string; hasVatPrefix: boolean }
  | { ok: false; reason: "format" | "check_digit" };

/** Validează un CUI scris de client (`14399840`, `RO14399840`, `ro 14399840`). */
export function validateCui(input: string): CuiValidation {
  const match = CUI_PATTERN.exec(input.trim());
  if (!match) return { ok: false, reason: "format" };
  const digits = match[2] as string;
  const body = digits.slice(0, -1);
  if (cuiCheckDigit(body) !== Number(digits.slice(-1))) return { ok: false, reason: "check_digit" };
  return { ok: true, digits, hasVatPrefix: match[1] !== undefined };
}
