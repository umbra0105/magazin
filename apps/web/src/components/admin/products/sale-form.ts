import {
  MAX_SALE_STEP,
  QuantityError,
  formatQuantity,
  parseQuantity,
  quantityFromTicks,
  saleStepToInt,
  stepsToQuantity,
} from "@ecom/shared/quantity";

/**
 * Logica pură a câmpurilor de vânzare (pas, minim, conversie SmartBill): citirea textului tastat (virgulă sau punct,
 * exact, fără `float`), mesaje în română și cererea către server cu DOAR câmpurile modificate. Serverul rămâne
 * autoritatea: validează din nou, inclusiv față de unitatea efectivă și de conversia SmartBill.
 */

export interface SaleTexts {
  stepInvalid: string;
  stepDecimals: (maxDecimals: number) => string;
  stepPositive: string;
  stepTooBig: string;
  minInvalid: string;
  ratioInvalid: string;
  ratioMissing: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** O unitate de măsură, cât trebuie formularelor. */
export interface SaleUnit {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  isActive: boolean;
}

/** Pasul tastat (în unitatea produsului) → zecimi de miime pentru coloana `INT`; gol → `null` (o unitate). */
export function parseStepInput(
  text: string,
  unitDecimals: number,
  texts: SaleTexts,
): Parsed<number | null> {
  if (text.trim() === "") return { ok: true, value: null };
  try {
    const ticks = parseQuantity(text, { maxDecimals: unitDecimals });
    if (ticks === 0n) return { ok: false, message: texts.stepPositive };
    if (ticks > MAX_SALE_STEP) return { ok: false, message: texts.stepTooBig };
    return { ok: true, value: saleStepToInt(ticks) };
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    switch (error.reason) {
      case "too_many_decimals":
        return { ok: false, message: texts.stepDecimals(unitDecimals) };
      case "overflow":
        return { ok: false, message: texts.stepTooBig };
      default:
        return { ok: false, message: texts.stepInvalid };
    }
  }
}

/** Minimul în pași: număr întreg ≥ 1 (cel mult un milion) sau gol. */
export function parseMinInput(text: string, texts: SaleTexts): Parsed<number | null> {
  const raw = text.trim();
  if (raw === "") return { ok: true, value: null };
  const value = /^[0-9]{1,7}$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  if (value < 1 || value > 1_000_000) return { ok: false, message: texts.minInvalid };
  return { ok: true, value };
}

/** Pasul salvat → text de afișat în câmp („2,03”); `null` → gol. */
export function formatStepInput(step: number | null): string {
  return step === null ? "" : formatQuantity(quantityFromTicks(step));
}

/** Primele cantități care se pot comanda (multipli ai pasului), pentru previzualizare: „2,03 · 4,06 · …”. */
export function previewQuantities(step: number | null, count = 4): string[] {
  const unit = quantityFromTicks(step ?? 10_000);
  return Array.from({ length: count }, (_, index) =>
    formatQuantity(stepsToQuantity(index + 1, unit)),
  );
}

/** Cantitatea minimă comandabilă („4,06”): `minSteps × pas`; `null` dacă depășește plafonul unei cantități. */
export function formatMinimum(step: number | null, minSteps: number): string | null {
  try {
    return formatQuantity(stepsToQuantity(minSteps, quantityFromTicks(step ?? 10_000)));
  } catch (error) {
    if (error instanceof QuantityError) return null;
    throw error;
  }
}

/** Câmpurile de vânzare ale unei variante, ca text (cum le arată formularul). */
export interface VariantSaleValues {
  saleStep: string;
  minSteps: string;
  smartbillMode: string;
  smartbillUnitName: string;
  smartbillRatio: string;
  [key: string]: string;
}

function parseRatio(text: string, texts: SaleTexts): Parsed<number> {
  if (text.trim() === "") return { ok: false, message: texts.ratioMissing };
  const parsed = parseStepInput(text, 4, texts);
  if (!parsed.ok || parsed.value === null) return { ok: false, message: texts.ratioInvalid };
  return { ok: true, value: parsed.value };
}

/** Mesajele pe câmp pentru ce s-a modificat (aceleași reguli ca pe server, pentru răspuns imediat). */
export function validateVariantSale(
  values: VariantSaleValues,
  changed: readonly string[],
  unitDecimals: number,
  texts: SaleTexts,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const touched = (key: string) => changed.includes(key);
  if (touched("saleStep")) {
    const step = parseStepInput(values.saleStep, unitDecimals, texts);
    if (!step.ok) errors["saleStep"] = step.message;
  }
  if (touched("minSteps")) {
    const min = parseMinInput(values.minSteps, texts);
    if (!min.ok) errors["minSteps"] = min.message;
  }
  if ((touched("smartbillMode") || touched("smartbillRatio")) && values.smartbillMode === "ratio") {
    const ratio = parseRatio(values.smartbillRatio, texts);
    if (!ratio.ok) errors["smartbillRatio"] = ratio.message;
  }
  return errors;
}

/**
 * Cererea către server: doar câmpurile modificate. Modul și raportul merg MEREU împreună (raportul există doar la
 * modul «raport»; la oricare altul se trimite `null`), ca baza să nu primească „una setată, una nulă”.
 */
export function buildVariantSalePatch(
  values: VariantSaleValues,
  changed: readonly string[],
  unitDecimals: number,
  texts: SaleTexts,
): { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors = validateVariantSale(values, changed, unitDecimals, texts);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const patch: Record<string, unknown> = {};
  if (changed.includes("saleStep")) {
    const step = parseStepInput(values.saleStep, unitDecimals, texts);
    patch["saleStep"] = step.ok ? step.value : null;
  }
  if (changed.includes("minSteps")) {
    const min = parseMinInput(values.minSteps, texts);
    patch["minSteps"] = min.ok ? min.value : null;
  }
  if (changed.includes("smartbillMode") || changed.includes("smartbillRatio")) {
    patch["smartbillMode"] = values.smartbillMode === "" ? null : values.smartbillMode;
    if (values.smartbillMode === "ratio") {
      const ratio = parseRatio(values.smartbillRatio, texts);
      patch["smartbillRatio"] = ratio.ok ? ratio.value : null;
    } else {
      patch["smartbillRatio"] = null;
    }
  }
  if (changed.includes("smartbillUnitName")) {
    const name = values.smartbillUnitName.trim();
    patch["smartbillUnitName"] = name === "" ? null : name;
  }
  return { ok: true, patch };
}
