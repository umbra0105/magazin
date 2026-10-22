import { QUANTITY_SCALE, type QuantityDelta } from "@ecom/shared";
import type { AdjustmentReason } from "./constants";

/**
 * Regulile PURE ale ajustărilor manuale de stoc fizic (Faza 5, punctul 6): motivele fixe (D8) cu etichetele lor,
 * semnul cerut de fiecare motiv, precizia unității și ora efectivă. Serviciul (`StockService.adjustPhysical`) le aplică
 * sub blocarea rândului de stoc; interfața le folosește pentru mesaje.
 */

/** Etichetele motivelor din D8, în română (singurul loc unde apar) */
export const ADJUSTMENT_REASON_LABELS: Readonly<Record<AdjustmentReason, string>> = {
  sale_in_store: "Vânzare în magazin",
  receipt: "Recepție marfă",
  return: "Retur",
  inventory_correction: "Inventariere (corecție)",
  damaged: "Deteriorat",
  lost_stolen: "Pierdut/Furt",
  other: "Alt motiv",
};

export type AdjustmentSignRule = "decrease" | "increase" | "either";

/**
 * Sensul ajustării cerut de motiv. Vânzarea în magazin, deteriorarea și furtul/pierderea doar scad stocul; recepția doar
 * îl crește. «Retur» (de la client sau către furnizor), inventarierea și «Alt motiv» merg în ambele sensuri.
 */
export const ADJUSTMENT_SIGN_RULES: Readonly<Record<AdjustmentReason, AdjustmentSignRule>> = {
  sale_in_store: "decrease",
  damaged: "decrease",
  lost_stolen: "decrease",
  receipt: "increase",
  return: "either",
  inventory_correction: "either",
  other: "either",
};

/** Textul liber al ajustării (obligatoriu) */
export const ADJUSTMENT_NOTE_MAX = 500;

/** Cât de mult în viitor poate fi ora efectivă (ceasuri ușor nepotrivite între server și browser) */
export const EFFECTIVE_AT_TOLERANCE_MS = 60_000;

/** `null` dacă semnul variației e cel cerut de motiv; altfel în ce sens trebuia să fie. */
export function adjustmentSignProblem(
  reason: AdjustmentReason,
  delta: QuantityDelta,
): "must_decrease" | "must_increase" | null {
  const rule = ADJUSTMENT_SIGN_RULES[reason];
  if (rule === "decrease" && delta > 0n) return "must_decrease";
  if (rule === "increase" && delta < 0n) return "must_increase";
  return null;
}

/**
 * Variația se încadrează în precizia unității (câte zecimale are voie cantitatea, 0–4)? Pasul de vânzare NU contează
 * aici: o ajustare fizică poate fi orice cantitate exprimabilă în unitate (1 mp dintr-o rolă de 41,25 mp).
 */
export function fitsUnitPrecision(delta: QuantityDelta, decimals: number): boolean {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > QUANTITY_SCALE) {
    throw new RangeError(`Zecimalele unității trebuie să fie între 0 și ${QUANTITY_SCALE}`);
  }
  return delta % 10n ** BigInt(QUANTITY_SCALE - decimals) === 0n;
}

/** Ora efectivă a ajustării: o dată validă, cel mult cu toleranța în viitor (trecutul e oricând permis). */
export function effectiveAtProblem(effectiveAt: Date, now: Date): "invalid" | "future" | null {
  const time = effectiveAt.getTime();
  if (Number.isNaN(time)) return "invalid";
  if (time > now.getTime() + EFFECTIVE_AT_TOLERANCE_MS) return "future";
  return null;
}
