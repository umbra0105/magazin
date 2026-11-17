import { DomainError } from "./errors";
import { QUANTITY_FACTOR, quantityFromTicks, type Quantity } from "./quantity";

/**
 * Helperul `Money` (Faza 8): aritmetica EXACTĂ a prețurilor, peste primitivele din `quantity.ts`. Sumele finale sunt `int` în
 * bani (minor units); aici, înaintea rotunjirii, o valoare e o FRACȚIE EXACTĂ de bani (`bigint` / `bigint`), niciodată `float`.
 *
 * Regula de rotunjire (decisă 2026-11-17, de confirmat în sandbox-ul SmartBill, Faza 13): **o singură rotunjire pe linie, la
 * 2 zecimale (la bani), half-up, în magazin.** Totalul comenzii e suma liniilor rotunjite; nu se mai rotunjește nimic după.
 *  - R1 (preț pe UNITATE): linia = rotunjire(preț pe unitate × cantitate), o singură dată;
 *  - R2 (preț pe PAS): linia = preț pe pas × număr de pași, exact (pașii sunt întregi, deci nu rămâne nimic de rotunjit).
 * Reducerile (grup, cupon procentual) se aplică pe valoarea EXACTĂ, nu pe una deja rotunjită; singura rotunjire e cea finală.
 *
 * Plafonul unei linii (`maxLineMinor`, `MAX_MONEY` din catalog) se verifică pe valoarea exactă: peste el se REFUZĂ, nu se taie.
 */

export const MONEY_ERROR_REASONS = ["invalid_amount", "invalid_fraction", "overflow"] as const;
export type MoneyErrorReason = (typeof MONEY_ERROR_REASONS)[number];

/** Eroare de bani cu cod stabil `MONEY_<MOTIV>` (ex. `MONEY_OVERFLOW`). */
export class MoneyError extends DomainError {
  readonly reason: MoneyErrorReason;

  constructor(reason: MoneyErrorReason, message: string, details?: Record<string, unknown>) {
    super(`MONEY_${reason.toUpperCase()}`, message, { reason, ...details });
    this.reason = reason;
  }
}

function fail(reason: MoneyErrorReason, message: string): never {
  throw new MoneyError(reason, message);
}

/** O valoare exactă în bani: `num / den`, `num ≥ 0`, `den > 0`. Nu se construiește de mână în afara acestui modul. */
export interface ExactMoney {
  readonly num: bigint;
  readonly den: bigint;
}

function toBigInt(value: number | bigint, reason: MoneyErrorReason, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(reason, `${what} trebuie să fie un număr întreg.`);
  }
  return BigInt(value);
}

/** Bani întregi (`int`) → valoare exactă. */
export function exactFromMinor(minor: number | bigint): ExactMoney {
  const num = toBigInt(minor, "invalid_amount", "Suma în bani");
  if (num < 0n) return fail("invalid_amount", "Suma nu poate fi negativă.");
  return { num, den: 1n };
}

/** `num / den` bani, exact. Numitorul trebuie să fie pozitiv, numărătorul ≥ 0. */
export function exactFraction(num: number | bigint, den: number | bigint): ExactMoney {
  const n = toBigInt(num, "invalid_fraction", "Numărătorul");
  const d = toBigInt(den, "invalid_fraction", "Numitorul");
  if (d <= 0n) return fail("invalid_fraction", "Numitorul trebuie să fie pozitiv.");
  if (n < 0n) return fail("invalid_fraction", "Valoarea nu poate fi negativă.");
  return { num: n, den: d };
}

/** `valoare × num / den` (de exemplu `× 9500 / 10000` pentru −5%), exact. */
export function scaleExact(
  value: ExactMoney,
  num: number | bigint,
  den: number | bigint,
): ExactMoney {
  const factor = exactFraction(num, den);
  return { num: value.num * factor.num, den: value.den * factor.den };
}

export function compareExact(a: ExactMoney, b: ExactMoney): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function minExact(a: ExactMoney, b: ExactMoney): ExactMoney {
  return compareExact(a, b) <= 0 ? a : b;
}

/** Valoarea e un număr întreg de bani (nu rămâne nimic de rotunjit)? */
export function isWholeMinor(value: ExactMoney): boolean {
  return value.num % value.den === 0n;
}

/** Rotunjirea half-up la bani (2 zecimale în lei): `.5` în sus. Singurul loc din proiect care rotunjește sume. */
export function roundHalfUp(value: ExactMoney): bigint {
  return (2n * value.num + value.den) / (2n * value.den);
}

/** Bani întregi (`bigint`) → `number` sigur pentru coloanele `INT` și pentru JSON; refuză ce nu încape exact. */
export function minorToNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail("overflow", "Suma nu încape într-un număr întreg sigur.");
  }
  return Number(value);
}

export interface MoneyLineOptions {
  /** Plafonul unei linii, în bani (ex. `MAX_MONEY` din catalog); peste el se refuză, nu se taie. */
  maxLineMinor?: number | bigint;
}

function assertWithinLine(value: ExactMoney, options: MoneyLineOptions): void {
  if (options.maxLineMinor === undefined) return;
  const max = toBigInt(options.maxLineMinor, "invalid_amount", "Plafonul liniei");
  if (value.num > max * value.den) {
    fail("overflow", "Valoarea liniei depășește maximul permis.");
  }
}

/** R1: preț pe UNITATE (exact, poate fi fracție după reduceri) × cantitate, exact, cu plafonul liniei. */
export function lineByUnitPrice(
  unitPrice: ExactMoney,
  quantity: Quantity,
  options: MoneyLineOptions = {},
): ExactMoney {
  const ticks = quantityFromTicks(quantity);
  const line = { num: unitPrice.num * ticks, den: unitPrice.den * QUANTITY_FACTOR };
  assertWithinLine(line, options);
  return line;
}

/** R2: preț pe PAS (exact) × număr de pași (întreg), cu plafonul liniei. */
export function lineByStepPrice(
  stepPrice: ExactMoney,
  steps: bigint | number,
  options: MoneyLineOptions = {},
): ExactMoney {
  const count = toBigInt(steps, "invalid_amount", "Numărul de pași");
  if (count < 0n) return fail("invalid_amount", "Numărul de pași nu poate fi negativ.");
  const line = { num: stepPrice.num * count, den: stepPrice.den };
  assertWithinLine(line, options);
  return line;
}

/**
 * Repartizează o sumă FIXĂ în bani (cupon cu valoare fixă, puncte de loialitate) pe linii, proporțional cu ponderile lor,
 * în bani întregi: suma părților e EXACT totalul, iar restul merge la liniile cu cea mai mare parte fracționară (la egalitate,
 * prima). Nicio parte nu depășește ponderea ei (reducerea unei linii nu poate trece de valoarea liniei); un total peste suma
 * ponderilor se refuză, nu se taie.
 */
export function allocateMinor(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) return fail("invalid_amount", "Suma de repartizat nu poate fi negativă.");
  if (weights.some((weight) => weight < 0n)) {
    return fail("invalid_amount", "Ponderile nu pot fi negative.");
  }
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (total > sum) return fail("overflow", "Suma de repartizat depășește valoarea liniilor.");
  if (total === 0n || sum === 0n) return weights.map(() => 0n);

  const parts = weights.map((weight) => (total * weight) / sum);
  const remainders = weights.map((weight, index) => ({
    index,
    fraction: (total * weight) % sum,
  }));
  let left = total - parts.reduce((acc, part) => acc + part, 0n);
  remainders.sort((a, b) =>
    a.fraction === b.fraction ? a.index - b.index : a.fraction > b.fraction ? -1 : 1,
  );
  for (const entry of remainders) {
    if (left === 0n) break;
    const room = (weights[entry.index] as bigint) - (parts[entry.index] as bigint);
    if (room > 0n) {
      parts[entry.index] = (parts[entry.index] as bigint) + 1n;
      left -= 1n;
    }
  }
  return parts;
}
