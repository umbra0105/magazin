import type { RateOffer, ShippingClass } from "./types";

/**
 * Pragul de transport gratuit, dezactivabil PE CLASĂ de transport și PE PRODUS (docs/15 §1: la o pompă de 8.000 de lei, un
 * prag de 500 de lei ar costa marja). Regula: transportul e gratuit doar dacă pragul e setat, subtotalul îl atinge și TOATE
 * liniile fizice sunt eligibile (clasa lor e activată pentru scutire — implicit doar `standard` — și produsul nu e exclus). O
 * singură linie neeligibilă dezactivează scutirea pentru toată comanda: transportul ei rămâne al nostru.
 */

export type FreeShippingDenial =
  "disabled" | "no_lines" | "class_excluded" | "product_excluded" | "below_threshold";

export interface FreeShippingInput {
  /** `checkout.freeShippingThreshold` (bani, cu TVA) sau `null` = dezactivat. */
  thresholdMinor: number | null;
  /** `checkout.freeShippingClasses`: clasele la care se aplică scutirea. */
  enabledClasses: readonly ShippingClass[];
  excludedProductIds: readonly string[];
  /** Subtotalul produselor fizice, după reduceri, fără transport. */
  subtotalMinor: number;
  lines: ReadonlyArray<{ productId: string; shippingClass: ShippingClass }>;
}

export type FreeShippingEligibility =
  { eligible: true } | { eligible: false; reason: FreeShippingDenial };

export function freeShippingEligibility(input: FreeShippingInput): FreeShippingEligibility {
  if (input.thresholdMinor === null) return { eligible: false, reason: "disabled" };
  if (input.lines.length === 0) return { eligible: false, reason: "no_lines" };
  if (input.lines.some((line) => !input.enabledClasses.includes(line.shippingClass))) {
    return { eligible: false, reason: "class_excluded" };
  }
  const excluded = new Set(input.excludedProductIds);
  if (input.lines.some((line) => excluded.has(line.productId))) {
    return { eligible: false, reason: "product_excluded" };
  }
  if (input.subtotalMinor < input.thresholdMinor) {
    return { eligible: false, reason: "below_threshold" };
  }
  return { eligible: true };
}

/** Transportul devine 0 la curier și easybox când pragul e atins; taxa de ramburs și ridicarea personală rămân neatinse. */
export function applyFreeShipping(offers: readonly RateOffer[], eligible: boolean): RateOffer[] {
  if (!eligible) return [...offers];
  return offers.map((offer) =>
    offer.kind === "pickup" ? offer : { ...offer, priceMinor: 0, freeShipping: true },
  );
}
