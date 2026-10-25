/**
 * Cantități EXACTE pentru stoc, comenzi și unități de măsură (Faza 5, D11). Singura aritmetică permisă pe cantități.
 *
 * O cantitate este un număr ÎNTREG de zecimi de miime de unitate (4 zecimale): `2,03 mp` = `20300n`, `25 kg` = `250000n`.
 * Nu există `float` nicăieri în drum: nici la citire (se lucrează pe șirul de cifre), nici în calcul (`bigint`), nici la
 * afișare. Pentru valori ca `0,1 + 0,2` sau `3 × 2,03` rezultatul este exact (`0,3`, `6,09`), spre deosebire de `number`.
 *
 * Modulul NU știe cum se rotunjește un preț: `exactLineValue` dă valoarea exactă (în bani × 10⁻⁴), iar regula de
 * rotunjire (R1/R2, o singură rotunjire pe linie) aparține motorului de prețuri (Faza 8). Aici se rotunjește doar în
 * JOS, la 4 zecimale, la conversiile de unitate (niciodată în sus: nu se creează stoc inexistent), cu semnal de pierdere.
 */
import { DomainError } from "./errors";

declare const quantityBrand: unique symbol;
declare const deltaBrand: unique symbol;

/** Cantitate ≥ 0 în zecimi de miime de unitate. Se obține doar prin funcțiile acestui modul (validate). */
export type Quantity = bigint & { readonly [quantityBrand]: true };
/** Variație de cantitate (poate fi negativă), în zecimi de miime; ex. o ajustare de stoc. */
export type QuantityDelta = bigint & { readonly [deltaBrand]: true };

/** Zecimale păstrate. */
export const QUANTITY_SCALE = 4;
/** Zecimi de miime într-o unitate (10⁴). */
export const QUANTITY_FACTOR = 10_000n;
/** Plafonul unei cantități: 10¹² zecimi de miime = 100.000.000 de unități (oglindește CHECK-urile din bază). */
export const MAX_QUANTITY = 1_000_000_000_000n as Quantity;
/** Pasul de vânzare e stocat într-o coloană `INT`: cel mult 2.147.483.647 zecimi de miime (~214.748 de unități). */
export const MAX_SALE_STEP = 2_147_483_647n;

export const QUANTITY_ERROR_REASONS = [
  "invalid_format",
  "too_many_decimals",
  "negative",
  "not_positive",
  "overflow",
  "invalid_step",
  "not_multiple_of_step",
  "below_minimum",
  "invalid_price",
  "invalid_argument",
] as const;
export type QuantityErrorReason = (typeof QUANTITY_ERROR_REASONS)[number];

/** Eroare de cantitate cu cod stabil `QUANTITY_<MOTIV>` (ex. `QUANTITY_NOT_MULTIPLE_OF_STEP`). */
export class QuantityError extends DomainError {
  readonly reason: QuantityErrorReason;

  constructor(reason: QuantityErrorReason, message: string, details?: Record<string, unknown>) {
    super(`QUANTITY_${reason.toUpperCase()}`, message, { reason, ...details });
    this.reason = reason;
  }
}

function fail(
  reason: QuantityErrorReason,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new QuantityError(reason, message, details);
}

// ---------------------------------------------------------------------------
// Granița: din/în zecimi de miime
// ---------------------------------------------------------------------------

function integerToBigInt(
  value: bigint | number,
  reason: QuantityErrorReason,
  what: string,
): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(reason, `${what} trebuie să fie un număr întreg.`);
  }
  return BigInt(value);
}

function checked(ticks: bigint): Quantity {
  if (ticks < 0n) return fail("negative", "Cantitatea nu poate fi negativă.");
  if (ticks > MAX_QUANTITY) {
    return fail(
      "overflow",
      `Cantitatea depășește valoarea maximă (${formatQuantity(MAX_QUANTITY)}).`,
    );
  }
  return ticks as Quantity;
}

/** Valoare din baza de date (`BIGINT`) sau dintr-un număr întreg de zecimi de miime → cantitate validată. */
export function quantityFromTicks(value: bigint | number): Quantity {
  return checked(integerToBigInt(value, "invalid_argument", "Valoarea în zecimi de miime"));
}

// ---------------------------------------------------------------------------
// Citire
// ---------------------------------------------------------------------------

const NUMBER_PATTERN = /^(-?)([0-9]+)(?:[.,]([0-9]+))?$/;
const MAX_INPUT_LENGTH = 40;

export interface ParseOptions {
  /** Câte zecimale are voie (zecimalele unității de măsură), 0–4; implicit 4. */
  maxDecimals?: number;
}

interface ParsedCore {
  ticks: bigint;
  negative: boolean;
  truncated: boolean;
}

function resolveDecimals(maxDecimals: number | undefined): number {
  const decimals = maxDecimals ?? QUANTITY_SCALE;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > QUANTITY_SCALE) {
    return fail(
      "invalid_argument",
      `Numărul de zecimale trebuie să fie între 0 și ${QUANTITY_SCALE}.`,
    );
  }
  return decimals;
}

function decimalsMessage(decimals: number): string {
  return decimals === 0
    ? "Cantitatea trebuie să fie un număr întreg."
    : `Cantitatea poate avea cel mult ${decimals} ${decimals === 1 ? "zecimală" : "zecimale"}.`;
}

function parseCore(
  input: string,
  options: ParseOptions,
  floor: boolean,
  signed = false,
): ParsedCore {
  const decimals = resolveDecimals(options.maxDecimals);
  const trimmed = typeof input === "string" ? input.trim() : "";
  // variațiile cu semn acceptă și «+» în față (`formatSignedDelta` îl produce); cantitățile obișnuite rămân stricte
  const text = signed ? trimmed.replace(/^\+(?=[0-9])/, "") : trimmed;
  const match =
    text.length > 0 && text.length <= MAX_INPUT_LENGTH ? NUMBER_PATTERN.exec(text) : null;
  if (!match) {
    return fail(
      "invalid_format",
      "Cantitatea nu este un număr valid. Folosește cifre și o singură virgulă, de exemplu 2,5.",
    );
  }
  const sign = match[1] ?? "";
  const whole = (match[2] ?? "0").replace(/^0+(?=[0-9])/, "");
  let fraction = (match[3] ?? "").replace(/0+$/, "");
  let truncated = false;
  if (fraction.length > decimals) {
    if (!floor)
      return fail("too_many_decimals", decimalsMessage(decimals), { maxDecimals: decimals });
    // în jos: cifrele dincolo de precizie se taie (niciodată rotunjire în sus)
    fraction = fraction.slice(0, decimals);
    truncated = true;
  }
  if (whole.length > 9) {
    return fail(
      "overflow",
      `Cantitatea depășește valoarea maximă (${formatQuantity(MAX_QUANTITY)}).`,
    );
  }
  const ticks = BigInt(whole + fraction.padEnd(QUANTITY_SCALE, "0"));
  if (ticks > MAX_QUANTITY) {
    return fail(
      "overflow",
      `Cantitatea depășește valoarea maximă (${formatQuantity(MAX_QUANTITY)}).`,
    );
  }
  return { ticks, negative: sign === "-" && ticks !== 0n, truncated };
}

/**
 * Cantitate din text cu virgulă sau punct zecimal (`2,03` / `2.03`). Strict: refuză separatorul de mii, semnul `+`,
 * notația științifică, numerele negative, depășirea plafonului și zecimalele peste `maxDecimals` (nu rotunjește).
 */
export function parseQuantity(input: string, options: ParseOptions = {}): Quantity {
  const parsed = parseCore(input, options, false);
  if (parsed.negative) return fail("negative", "Cantitatea nu poate fi negativă.");
  return parsed.ticks as Quantity;
}

/**
 * Ca `parseQuantity`, dar zecimalele în plus se taie ÎN JOS (niciodată în sus) și rezultatul spune dacă s-a pierdut ceva
 * (importul „stoc la zi” din SmartBill: pierderea apare în raport).
 */
export function parseQuantityDetailed(
  input: string,
  options: ParseOptions = {},
): { quantity: Quantity; truncated: boolean } {
  const parsed = parseCore(input, options, true);
  if (parsed.negative) return fail("negative", "Cantitatea nu poate fi negativă.");
  return { quantity: parsed.ticks as Quantity, truncated: parsed.truncated };
}

/** Variație cu semn (ajustări de stoc): `-2,5`, `2,5`, `0`; în intervalul ±plafon, fără rotunjire. */
export function parseSignedDelta(input: string, options: ParseOptions = {}): QuantityDelta {
  const parsed = parseCore(input, options, false, true);
  return (parsed.negative ? -parsed.ticks : parsed.ticks) as QuantityDelta;
}

/**
 * Textul poate fi un separator de mii, nu unul zecimal? («1.234», «1,234»: 1234 sau 1,234?). Importurile din CSV/Excel
 * refuză astfel de celule cu explicație, în loc să ghicească. «0,123» și «1,2345» nu sunt ambigue.
 */
export function isAmbiguousSeparatorText(text: string): boolean {
  return /^[1-9][0-9]{0,2}[.,][0-9]{3}$/.test(text.trim());
}

// ---------------------------------------------------------------------------
// Afișare
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Zecimale afișate cel puțin (completate cu zero); implicit 0. */
  minDecimals?: number;
  /** Zecimale afișate cel mult (cele în plus se taie în jos, doar la afișare); implicit 4. */
  maxDecimals?: number;
}

/** `825000n` → `82,5`; fără separator de mii, cu virgulă; zerourile de la coadă dispar până la `minDecimals`. */
export function formatQuantity(value: Quantity, options: FormatOptions = {}): string {
  const min = options.minDecimals ?? 0;
  const max = options.maxDecimals ?? QUANTITY_SCALE;
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 0 ||
    max > QUANTITY_SCALE ||
    min > max
  ) {
    return fail("invalid_argument", "Formatul cere zecimale între 0 și 4, cu minimul sub maxim.");
  }
  const whole = value / QUANTITY_FACTOR;
  let fraction = (value % QUANTITY_FACTOR).toString().padStart(QUANTITY_SCALE, "0").slice(0, max);
  while (fraction.length > min && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction === "" ? whole.toString() : `${whole.toString()},${fraction}`;
}

/** `82,5 mp` (simbolul unității vine din tabela de unități, nu se hardcodează). */
export function formatQuantityWithUnit(
  value: Quantity,
  unitSymbol: string,
  options: FormatOptions = {},
): string {
  return `${formatQuantity(value, options)} ${unitSymbol}`;
}

/** `+2,5` / `-2,5` / `0`. */
export function formatSignedDelta(delta: QuantityDelta, options: FormatOptions = {}): string {
  if (delta === 0n) return "0";
  const magnitude = (delta < 0n ? -delta : delta) as Quantity;
  return `${delta < 0n ? "-" : "+"}${formatQuantity(magnitude, options)}`;
}

// ---------------------------------------------------------------------------
// Aritmetică pe cantități
// ---------------------------------------------------------------------------

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return checked(a + b);
}

/** Scădere fără stoc negativ (D5): `b > a` se refuză. */
export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  if (b > a) return fail("negative", "Stocul nu poate deveni negativ.");
  return (a - b) as Quantity;
}

export function sumQuantities(values: readonly Quantity[]): Quantity {
  return values.reduce<Quantity>((total, value) => addQuantity(total, value), 0n as Quantity);
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minQuantity(a: Quantity, b: Quantity): Quantity {
  return a < b ? a : b;
}

export function maxQuantity(a: Quantity, b: Quantity): Quantity {
  return a > b ? a : b;
}

/** Variația de la `from` la `to` (negativă dacă scade). */
export function deltaBetween(from: Quantity, to: Quantity): QuantityDelta {
  return (to - from) as QuantityDelta;
}

/** Aplică o variație; rezultatul negativ sau peste plafon se refuză. */
export function applyDelta(value: Quantity, delta: QuantityDelta): Quantity {
  const next = value + delta;
  if (next < 0n) return fail("negative", "Stocul nu poate deveni negativ.");
  return checked(next);
}

// ---------------------------------------------------------------------------
// Pasul de vânzare: multipli exacți
// ---------------------------------------------------------------------------

/**
 * Pasul de vânzare validat: întreg > 0, în limita coloanei `INT`, cu cel mult atâtea zecimale câte are unitatea
 * (un pas de 2,5 nu are sens la o unitate fără zecimale). `unitDecimals` implicit 4 (nu restrânge).
 */
export function assertSaleStep(value: number | bigint, unitDecimals = QUANTITY_SCALE): Quantity {
  const step = integerToBigInt(value, "invalid_step", "Pasul de vânzare");
  if (step <= 0n || step > MAX_SALE_STEP) {
    return fail(
      "invalid_step",
      "Pasul de vânzare trebuie să fie pozitiv și cel mult 214.748 de unități.",
    );
  }
  const decimals = resolveDecimals(unitDecimals);
  if (step % 10n ** BigInt(QUANTITY_SCALE - decimals) !== 0n) {
    return fail(
      "invalid_step",
      `Pasul de vânzare are mai multe zecimale decât permite unitatea (${decimals}).`,
      { unitDecimals: decimals },
    );
  }
  return step as Quantity;
}

/** Pasul validat ca număr întreg pentru coloana `INT` (cererile către server îl trimit așa); exact, fără rotunjire. */
export function saleStepToInt(step: bigint): number {
  return Number.parseInt(assertSaleStep(step).toString(), 10);
}

function requirePositiveStep(step: Quantity): void {
  if (typeof step !== "bigint" || step <= 0n) {
    fail("invalid_argument", "Pasul de vânzare trebuie să fie pozitiv.");
  }
}

function requireStepCount(steps: bigint | number): bigint {
  const count = integerToBigInt(steps, "invalid_argument", "Numărul de pași");
  if (count < 0n) return fail("invalid_argument", "Numărul de pași nu poate fi negativ.");
  return count;
}

/** Cantitatea e un multiplu EXACT al pasului? (zero este multiplu; cererea de comandă îl refuză separat) */
export function isMultipleOf(value: Quantity, step: Quantity): boolean {
  requirePositiveStep(step);
  return value % step === 0n;
}

/** Numărul de pași dintr-o cantitate care este multiplu exact; altfel eroare cu pasul în mesaj. */
export function stepsIn(value: Quantity, step: Quantity): bigint {
  requirePositiveStep(step);
  if (value % step !== 0n) {
    return fail(
      "not_multiple_of_step",
      `Cantitatea trebuie să fie multiplu de ${formatQuantity(step)}.`,
      { step: formatQuantity(step) },
    );
  }
  return value / step;
}

/** Câți pași ÎNTREGI încap în `available` (disponibil în pași). */
export function floorSteps(available: Quantity, step: Quantity): bigint {
  requirePositiveStep(step);
  return available / step;
}

/** Restul nevandabil: ce rămâne după pașii întregi. */
export function remainderAfterSteps(available: Quantity, step: Quantity): Quantity {
  requirePositiveStep(step);
  return (available % step) as Quantity;
}

/** `pași × pas`, cu verificarea plafonului. */
export function stepsToQuantity(steps: bigint | number, step: Quantity): Quantity {
  requirePositiveStep(step);
  return checked(requireStepCount(steps) * step);
}

/** Cantitatea minimă comandabilă: `minSteps × pas` (implicit un pas). */
export function minimumOrderQuantity(step: Quantity, minSteps?: number | bigint | null): Quantity {
  const count = minSteps === null || minSteps === undefined ? 1n : requireStepCount(minSteps);
  if (count < 1n)
    return fail("invalid_argument", "Minimul comandat trebuie să fie cel puțin un pas.");
  return stepsToQuantity(count, step);
}

export interface OrderQuantityRules {
  step: Quantity;
  minSteps?: number | bigint | null;
}

/**
 * Validarea unei cantități comandate: pozitivă, multiplu exact al pasului, cel puțin minimul. Întoarce numărul de pași.
 * (Validarea la server la adăugare în coș, modificare, plasare și rezervare folosește aceeași funcție.)
 */
export function assertOrderQuantity(value: Quantity, rules: OrderQuantityRules): bigint {
  if (value <= 0n) return fail("not_positive", "Cantitatea trebuie să fie mai mare decât zero.");
  const steps = stepsIn(value, rules.step);
  const minimum = minimumOrderQuantity(rules.step, rules.minSteps);
  if (value < minimum) {
    return fail("below_minimum", `Cantitatea minimă este ${formatQuantity(minimum)}.`, {
      minimum: formatQuantity(minimum),
    });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Conversii de unitate (SmartBill ↔ unitatea noastră): în JOS, cu semnal de pierdere
// ---------------------------------------------------------------------------

export interface ScaledQuantity {
  quantity: Quantity;
  /** Rezultatul exact avea mai mult de 4 zecimale și s-a rotunjit în jos */
  lossy: boolean;
}

function requirePositiveFactor(factor: Quantity): void {
  if (typeof factor !== "bigint" || factor <= 0n) {
    fail("invalid_argument", "Factorul de conversie trebuie să fie pozitiv.");
  }
}

/** `cantitate × factor` (ex. 2,3333 role × 41,25 mp/rolă), în jos la 4 zecimale. */
export function multiplyByFactor(value: Quantity, factor: Quantity): ScaledQuantity {
  requirePositiveFactor(factor);
  const product = value * factor;
  return { quantity: checked(product / QUANTITY_FACTOR), lossy: product % QUANTITY_FACTOR !== 0n };
}

/** `cantitate ÷ factor` (ex. 100 mp ÷ 41,25 mp/rolă), în jos la 4 zecimale. */
export function divideByFactor(value: Quantity, factor: Quantity): ScaledQuantity {
  requirePositiveFactor(factor);
  const numerator = value * QUANTITY_FACTOR;
  return { quantity: checked(numerator / factor), lossy: numerator % factor !== 0n };
}

// ---------------------------------------------------------------------------
// Preț × cantitate: valoare EXACTĂ, fără regula de rotunjire
// ---------------------------------------------------------------------------

function priceToBigInt(price: number | bigint): bigint {
  const value =
    typeof price === "bigint" ? price : Number.isSafeInteger(price) ? BigInt(price) : -1n;
  if (value < 0n) {
    return fail("invalid_price", "Prețul trebuie să fie un număr întreg de bani, ≥ 0.");
  }
  return value;
}

export interface LineValueOptions {
  /** Plafonul unei linii, în bani (ex. `MAX_MONEY` din catalog); peste el se refuză, nu se taie. */
  maxLineMinor?: number | bigint;
}

function assertWithinLine(value: bigint, scale: bigint, options: LineValueOptions): void {
  if (options.maxLineMinor === undefined) return;
  const max = priceToBigInt(options.maxLineMinor) * scale;
  if (value > max) fail("overflow", "Valoarea liniei depășește maximul permis.");
}

/**
 * R1 (preț pe unitate): `preț (bani/unitate) × cantitate`, EXACT, în bani × 10⁻⁴ (10⁴ înseamnă 1 ban). Nu se rotunjește
 * aici: motorul de prețuri decide, o singură dată pe linie. `bigint`, fiindcă produsul depășește numerele exacte din
 * JavaScript (10⁹ bani × 10¹² = 10²¹).
 */
export function exactLineValue(
  unitPriceMinor: number | bigint,
  value: Quantity,
  options: LineValueOptions = {},
): bigint {
  const price = priceToBigInt(unitPriceMinor);
  const result = price * quantityFromTicks(value);
  assertWithinLine(result, QUANTITY_FACTOR, options);
  return result;
}

/** R2 (preț pe pas): `preț pe pas × număr de pași`, în bani întregi, fără nicio fracțiune. */
export function exactStepsValue(
  stepPriceMinor: number | bigint,
  steps: bigint | number,
  options: LineValueOptions = {},
): bigint {
  const result = priceToBigInt(stepPriceMinor) * requireStepCount(steps);
  assertWithinLine(result, 1n, options);
  return result;
}

export interface ScaledMoney {
  /** Valoare în bani × 10⁻⁴ (10⁴ înseamnă 1 ban), în jos */
  scaledMinor: bigint;
  /** Rezultatul exact avea mai mult de 4 zecimale de ban și s-a tăiat în jos */
  lossy: boolean;
}

/**
 * Prețul pe UNITATE dintr-un preț pe PAS: `preț pe pas ÷ pas`, EXACT până la 10⁻⁴ de ban (ex. 120,00 lei pe sacul de 25 kg
 * → 4,80 lei/kg). Doar în jos și cu semnal de pierdere, ca `divideByFactor`; NU alege rotunjirea (aceea e a motorului de
 * prețuri sau, la afișare, a celui care formatează).
 */
export function exactUnitPrice(stepPriceMinor: number | bigint, step: Quantity): ScaledMoney {
  const price = priceToBigInt(stepPriceMinor);
  const ticks = quantityFromTicks(step);
  if (ticks <= 0n) fail("invalid_argument", "Pasul trebuie să fie pozitiv.");
  const numerator = price * QUANTITY_FACTOR * QUANTITY_FACTOR;
  return { scaledMinor: numerator / ticks, lossy: numerator % ticks !== 0n };
}

/**
 * Descompune exact o valoare în bani × 10⁻⁴: bani întregi (partea întreagă) și restul, în aceeași scală. Nu alege
 * rotunjirea (în sus, în jos, la jumătate): doar oferă motorului de prețuri cele două părți fără pierdere.
 */
export function splitScaledMoney(scaled: bigint): { wholeMinor: bigint; remainderScaled: bigint } {
  if (typeof scaled !== "bigint" || scaled < 0n) {
    return fail("invalid_argument", "Valoarea trebuie să fie ≥ 0.");
  }
  return { wholeMinor: scaled / QUANTITY_FACTOR, remainderScaled: scaled % QUANTITY_FACTOR };
}
