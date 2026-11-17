import { createHash, randomBytes } from "node:crypto";
import {
  QuantityError,
  assertOrderQuantity,
  floorSteps,
  quantityFromTicks,
  stepsToQuantity,
  type Quantity,
} from "@ecom/shared";
import { checkOrderable, type Availability } from "../inventory/availability";

/**
 * Regulile PURE ale coșului (Faza 8): tokenul coșului de oaspete, validarea cantității (pasul exact, minimul, stocul, plafonul
 * tehnic), îmbinarea cantităților, problemele unei linii și pragul de transport gratuit. Fără acces la date: serviciul le
 * apelează cu valori citite din bază, iar Faza 9 (checkout) refolosește aceleași funcții la plasare.
 *
 * Coșul NU rezervă stoc (D4): disponibilitatea se verifică la adăugare, modificare și afișare, dar nu se reține nimic.
 */

// ---------------------------------------------------------------- token

const TOKEN_BYTES = 32; // 256 de biți aleatori criptografic (minimul cerut: 128)
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 de octeți în base64url, fără umplutură

/** Tokenul coșului de oaspete: 256 de biți din generatorul criptografic al sistemului, în base64url. */
export function generateCartToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Forma tokenului, verificată ÎNAINTE de orice interogare (valorile prost formate nu ajung în bază). */
export function isWellFormedCartToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/** Amprenta păstrată în baza de date (SHA-256, hex). Tokenul în sine nu se păstrează niciodată. */
export function hashCartToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Data la care expiră un coș modificat acum, după numărul de zile din setări. */
export function cartExpiry(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

// ---------------------------------------------------------------- cantitate

export interface CartLimits {
  maxLines: number;
  /** Cantitatea maximă pe linie, în pași. */
  maxStepsPerLine: number;
}

export type QuantityProblem = "not_positive" | "not_multiple_of_step" | "below_minimum" | "invalid";

export type CartRejection =
  | { reason: "not_sellable" }
  | { reason: "invalid_quantity"; detail: QuantityProblem; message: string }
  | { reason: "unavailable" }
  | { reason: "exceeds_available"; maxSteps: bigint }
  | { reason: "exceeds_limit"; maxSteps: bigint }
  | { reason: "too_many_lines"; maxLines: number }
  | { reason: "line_too_expensive" };

function problemOf(error: QuantityError): QuantityProblem {
  switch (error.reason) {
    case "not_positive":
    case "not_multiple_of_step":
    case "below_minimum":
      return error.reason;
    default:
      return "invalid";
  }
}

export interface QuantityCheckInput {
  quantity: Quantity;
  /** Pasul de vânzare efectiv. */
  step: Quantity;
  minSteps: number | null;
  availability: Availability;
  limits: CartLimits;
}

/**
 * Cantitatea cerută e validă pentru coș? Aceeași validare la adăugare, modificare și (în Faza 9) plasare: pozitivă, multiplu
 * EXACT al pasului, cel puțin minimul, în limita stocului (`checkOrderable`) și a plafonului tehnic pe linie.
 */
export function checkCartQuantity(
  input: QuantityCheckInput,
): { ok: true; steps: bigint } | { ok: false; rejection: CartRejection } {
  let steps: bigint;
  try {
    steps = assertOrderQuantity(input.quantity, { step: input.step, minSteps: input.minSteps });
  } catch (error) {
    if (error instanceof QuantityError) {
      return {
        ok: false,
        rejection: { reason: "invalid_quantity", detail: problemOf(error), message: error.message },
      };
    }
    throw error;
  }
  const orderable = checkOrderable(input.availability, steps);
  if (!orderable.ok) {
    return {
      ok: false,
      rejection:
        orderable.reason === "unavailable"
          ? { reason: "unavailable" }
          : { reason: "exceeds_available", maxSteps: orderable.maxSteps },
    };
  }
  const cap = BigInt(input.limits.maxStepsPerLine);
  if (steps > cap) return { ok: false, rejection: { reason: "exceeds_limit", maxSteps: cap } };
  return { ok: true, steps };
}

/**
 * Îmbinarea a două cantități ale aceleiași variante (coșul de oaspete în coșul utilizatorului): se adună; peste plafonul pe
 * linie se reduce la plafon, în pași întregi (rămâne multiplu exact al pasului), cu semnal. Stocul NU se verifică aici: starea
 * liniei se calculează la afișare, ca să nu se piardă produsele la autentificare.
 */
export function clampMergedQuantity(
  a: Quantity,
  b: Quantity,
  step: Quantity,
  maxStepsPerLine: number,
): { quantity: Quantity; clamped: boolean } {
  const sum = quantityFromTicks(BigInt(a) + BigInt(b));
  const cap = BigInt(maxStepsPerLine);
  if (floorSteps(sum, step) <= cap) return { quantity: sum, clamped: false };
  return { quantity: stepsToQuantity(cap, step), clamped: true };
}

// ---------------------------------------------------------------- probleme pe linie

export type CartIssue =
  | { type: "unavailable" }
  | { type: "exceeds_available"; maxSteps: number }
  | { type: "invalid_quantity"; detail: QuantityProblem }
  | { type: "price_changed"; fromMinor: number; toMinor: number };

export interface LineIssueInput {
  quantity: Quantity;
  step: Quantity;
  minSteps: number | null;
  /** Produsul e activ și nesters (`isSellable`). */
  sellable: boolean;
  availability: Availability;
  /** Prețul unitar efectiv pe care l-a confirmat clientul; `null` = linie nouă, nimic de comparat. */
  ackedUnitPriceMinor: number | null;
  currentUnitPriceMinor: number;
}

/**
 * Ce nu e în regulă cu o linie la această afișare. O linie indisponibilă are doar «unavailable» (ieșită din total); celelalte
 * probleme se adaugă una lângă alta. Totalul nu se modifică tăcut: schimbarea de preț apare ca mesaj până o confirmă clientul.
 */
export function lineIssues(input: LineIssueInput): CartIssue[] {
  if (!input.sellable || !input.availability.purchasable) return [{ type: "unavailable" }];
  const issues: CartIssue[] = [];
  try {
    const steps = assertOrderQuantity(input.quantity, {
      step: input.step,
      minSteps: input.minSteps,
    });
    const orderable = checkOrderable(input.availability, steps);
    if (!orderable.ok && orderable.reason === "exceeds_available") {
      issues.push({ type: "exceeds_available", maxSteps: Number(orderable.maxSteps) });
    }
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    issues.push({ type: "invalid_quantity", detail: problemOf(error) });
  }
  if (
    input.ackedUnitPriceMinor !== null &&
    input.ackedUnitPriceMinor !== input.currentUnitPriceMinor
  ) {
    issues.push({
      type: "price_changed",
      fromMinor: input.ackedUnitPriceMinor,
      toMinor: input.currentUnitPriceMinor,
    });
  }
  return issues;
}

// ---------------------------------------------------------------- transport gratuit

export interface FreeShippingProgress {
  thresholdMinor: number;
  remainingMinor: number;
  reached: boolean;
}

/**
 * Indicatorul pragului de transport gratuit. Setarea goală (`null`) = dezactivat: nu există indicator. Se compară totalul
 * coșului după reduceri, cu TVA, fără transport (pragul pe clasă de transport și pe produs vine în Faza 9).
 */
export function freeShippingProgress(
  thresholdMinor: number | null,
  totalMinor: number,
): FreeShippingProgress | null {
  if (thresholdMinor === null) return null;
  const remaining = Math.max(0, thresholdMinor - totalMinor);
  return { thresholdMinor, remainingMinor: remaining, reached: totalMinor >= thresholdMinor };
}
