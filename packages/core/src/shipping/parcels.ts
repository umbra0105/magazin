import { scaleWholeByQuantity, type Quantity } from "@ecom/shared";
import type { Parcel, ShippingClass } from "./types";

/**
 * Colete (Faza 9, regula simplă; Faza 12 o rafinează): un colet logic PE LINIE de comandă. Greutatea reală a liniei =
 * greutate pe unitate × cantitate; greutatea volumetrică = (L×l×h)/5000 (cm, kg) × cantitate; se tarifează pe cea mai MARE
 * dintre ele, comparată pe LINIE, nu pe produs. Aritmetica cantității trece doar prin `Quantity` (shared).
 * Dimensiunile sunt în mm, deci (L×l×h) în mm³ ÷ 1000 = cm³, ÷ 5000 = kg, × 1000 = g → grame = mm³ ÷ 5000.
 */

const VOLUMETRIC_DIVISOR_MM3_PER_GRAM = 5000n;

function ceilBigint(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor - 1n) / divisor;
}

/** Greutatea volumetrică a unei linii, în grame, în sus; 0 dacă lipsește vreo dimensiune. */
export function volumetricGrams(
  lengthMm: number | null,
  widthMm: number | null,
  heightMm: number | null,
  quantity: Quantity,
): number {
  if (lengthMm === null || widthMm === null || heightMm === null) return 0;
  const unitVolume = BigInt(lengthMm) * BigInt(widthMm) * BigInt(heightMm); // mm³ pe unitate
  const { whole, remainderTicks } = scaleWholeByQuantity(unitVolume, quantity);
  const totalMm3 = whole + (remainderTicks > 0n ? 1n : 0n);
  return Number(ceilBigint(totalMm3, VOLUMETRIC_DIVISOR_MM3_PER_GRAM));
}

/** Volumul unei linii, în cm³, în sus; 0 dacă lipsește vreo dimensiune (mm³ ÷ 1000). */
export function volumeCm3(
  lengthMm: number | null,
  widthMm: number | null,
  heightMm: number | null,
  quantity: Quantity,
): number {
  if (lengthMm === null || widthMm === null || heightMm === null) return 0;
  const unitVolume = BigInt(lengthMm) * BigInt(widthMm) * BigInt(heightMm); // mm³ pe unitate
  const { whole, remainderTicks } = scaleWholeByQuantity(unitVolume, quantity);
  const totalMm3 = whole + (remainderTicks > 0n ? 1n : 0n);
  return Number(ceilBigint(totalMm3, 1000n));
}

/** Cantitatea rotunjită în sus la bucăți întregi (zecimile de miime se rotunjesc în sus). */
export function wholeUnitsOf(quantity: Quantity): number {
  const { whole, remainderTicks } = scaleWholeByQuantity(1, quantity);
  return Number(whole + (remainderTicks > 0n ? 1n : 0n));
}

export interface BuildParcelInput {
  variantId: string;
  sku: string;
  shippingClass: ShippingClass;
  quantity: Quantity;
  /** Greutatea unei unități, în grame. */
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export function buildParcel(input: BuildParcelInput): Parcel {
  let realGrams = 0;
  if (input.weightGrams !== null) {
    const { whole, remainderTicks } = scaleWholeByQuantity(input.weightGrams, input.quantity);
    realGrams = Number(whole + (remainderTicks > 0n ? 1n : 0n));
  }
  const volumetric = volumetricGrams(input.lengthMm, input.widthMm, input.heightMm, input.quantity);
  return {
    variantId: input.variantId,
    sku: input.sku,
    shippingClass: input.shippingClass,
    realGrams,
    volumetricGrams: volumetric,
    chargeableGrams: Math.max(realGrams, volumetric),
    volumeCm3: volumeCm3(input.lengthMm, input.widthMm, input.heightMm, input.quantity),
    wholeUnits: wholeUnitsOf(input.quantity),
    lengthMm: input.lengthMm,
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    incomplete:
      input.weightGrams === null ||
      input.lengthMm === null ||
      input.widthMm === null ||
      input.heightMm === null,
  };
}

/** Greutatea totală tarifabilă a comenzii, în grame: suma greutăților tarifabile ale liniilor. */
export function chargeableGramsTotal(parcels: readonly Parcel[]): number {
  return parcels.reduce((sum, parcel) => sum + parcel.chargeableGrams, 0);
}
