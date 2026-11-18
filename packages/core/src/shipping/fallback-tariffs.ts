import { z } from "zod";
import type { RateOffer } from "./types";

/**
 * Rezerva de livrare: zone pe județe cu tarife fixe și praguri, editabile din admin. Se folosește când furnizorul de tarife nu
 * răspunde (eroare, timp depășit, fără oferte), ca checkout-ul să nu se blocheze niciodată.
 */

export interface FallbackMethod {
  id: string;
  code: string;
  name: string;
  carrier: string | null;
  type: "flat" | "weight" | "pickup";
  priceMinor: number;
  /** JSON din bază; pentru `weight`: `{ includedKg, perExtraKgMinor }`. */
  rules: unknown;
  freeAboveMinor: number | null;
  codFeeMinor: number;
  estimatedDays: number | null;
  isActive: boolean;
}

export interface FallbackZone {
  id: string;
  name: string;
  isActive: boolean;
  countyCodes: readonly number[];
  methods: readonly FallbackMethod[];
}

const weightRules = z.object({
  includedKg: z.number().min(0).catch(0).default(0),
  perExtraKgMinor: z.number().int().min(0).catch(0).default(0),
});

export interface FallbackInput {
  zones: readonly FallbackZone[];
  countyCode: number;
  /** Greutatea tarifabilă totală, în grame. */
  chargeableGrams: number;
  /** Subtotalul produselor (bani), pentru pragul propriu al metodei. */
  subtotalMinor: number;
}

function methodPrice(method: FallbackMethod, chargeableGrams: number): number {
  if (method.type !== "weight") return method.priceMinor;
  const rules = weightRules.parse(method.rules ?? {});
  const extraGrams = Math.max(0, chargeableGrams - Math.round(rules.includedKg * 1000));
  const extraKg = Math.ceil(extraGrams / 1000); // fiecare kg ÎNCEPUT în plus
  return method.priceMinor + extraKg * rules.perExtraKgMinor;
}

export function fallbackOffers(input: FallbackInput): RateOffer[] {
  const offers: RateOffer[] = [];
  for (const zone of input.zones) {
    if (!zone.isActive || !zone.countyCodes.includes(input.countyCode)) continue;
    for (const method of zone.methods) {
      if (!method.isActive || method.type === "pickup") continue;
      const free = method.freeAboveMinor !== null && input.subtotalMinor >= method.freeAboveMinor;
      offers.push({
        code: `fallback:${method.code}`,
        kind: "courier",
        carrier: method.carrier ?? method.name,
        service: method.name,
        priceMinor: free ? 0 : methodPrice(method, input.chargeableGrams),
        estimatedDays: method.estimatedDays,
        codFeeMinor: method.codFeeMinor,
        source: "fallback",
        demo: false,
        freeShipping: free,
      });
    }
  }
  return offers;
}
