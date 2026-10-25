/**
 * Formularul tabului Stoc din editorul de produs (Faza 5, punctul 9a): citirea termenului de livrare și a denumirii pasului
 * scrise de utilizator, alegerea suprascrierii de gestiune pe variantă și construirea cererii către server (doar câmpurile
 * modificate). Funcții PURE; textele vin din `messages/ro.ts`. Fără câmpuri native de număr: termenul e text, cu mesaje proprii.
 */

export interface StockTexts {
  leadTimeInvalid: string;
  leadTimeTooLong: string;
  labelTooLong: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Termenul de livrare: număr întreg de zile 0–365 sau gol (gol = se aplică brandul, apoi setarea globală). */
export function parseLeadTimeInput(text: string, texts: StockTexts): Parsed<number | null> {
  const raw = text.trim();
  if (raw === "") return { ok: true, value: null };
  if (!/^[0-9]{1,6}$/.test(raw)) return { ok: false, message: texts.leadTimeInvalid };
  const value = Number.parseInt(raw, 10);
  if (value > 365) return { ok: false, message: texts.leadTimeTooLong };
  return { ok: true, value };
}

export const STEP_LABEL_MAX = 30;

/** Denumirea pasului («sac», «rolă»): tăiată la capete, cel mult 30 de caractere; gol = fără denumire. */
export function parseStepLabelInput(text: string, texts: StockTexts): Parsed<string | null> {
  const value = text.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > STEP_LABEL_MAX) return { ok: false, message: texts.labelTooLong };
  return { ok: true, value };
}

export type VariantManage = "inherit" | "managed" | "unmanaged";

/** Suprascrierea salvată pe variantă (`null` = moștenește de la produs) → alegerea din selector. */
export function manageChoice(value: boolean | null): VariantManage {
  return value === null ? "inherit" : value ? "managed" : "unmanaged";
}

export function manageValue(choice: VariantManage): boolean | null {
  return choice === "inherit" ? null : choice === "managed";
}

/** Gestiunea efectivă: varianta peste produs. */
export function effectiveManage(productManages: boolean, choice: VariantManage): boolean {
  return choice === "inherit" ? productManages : choice === "managed";
}

export interface ProductStockValues {
  manageStock: boolean;
  stockStatus: string;
  allowBackorder: boolean;
  leadTimeDays: string;
}

/** Cererea pentru produs: doar câmpurile modificate; doar acestea se validează (o valoare veche nemodificată nu blochează). */
export function buildProductStockPatch(
  values: ProductStockValues,
  changed: readonly string[],
  texts: StockTexts,
): { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const patch: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const key of changed) {
    if (key === "leadTimeDays") {
      const parsed = parseLeadTimeInput(values.leadTimeDays, texts);
      if (parsed.ok) patch["leadTimeDays"] = parsed.value;
      else errors["leadTimeDays"] = parsed.message;
    } else if (key === "manageStock") patch["manageStock"] = values.manageStock;
    else if (key === "stockStatus") patch["stockStatus"] = values.stockStatus;
    else if (key === "allowBackorder") patch["allowBackorder"] = values.allowBackorder;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, patch };
}

export interface VariantStockValues {
  manage: VariantManage;
  /** Gol = moștenește starea produsului */
  status: string;
}

/** Cererea pentru o variantă: gestiunea (`true`/`false`/`null`) și disponibilitatea (`null` = moștenește). */
export function buildVariantStockPatch(
  values: VariantStockValues,
  changed: readonly string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (changed.includes("manage")) patch["manageStock"] = manageValue(values.manage);
  if (changed.includes("status"))
    patch["stockStatus"] = values.status === "" ? null : values.status;
  return patch;
}

export interface LeadTimeContext {
  brandDays: number | null;
  brandName: string | null;
  globalDays: number;
}

/** Termenul care se aplică acum, pe valoarea din câmp: produsul, altfel brandul, altfel setarea globală (0 zile e o valoare). */
export function effectiveLeadTime(
  fieldValue: number | null,
  context: LeadTimeContext,
): { days: number; origin: "product" | "brand" | "global"; brandName: string | null } {
  if (fieldValue !== null) return { days: fieldValue, origin: "product", brandName: null };
  if (context.brandDays !== null) {
    return { days: context.brandDays, origin: "brand", brandName: context.brandName };
  }
  return { days: context.globalDays, origin: "global", brandName: null };
}
