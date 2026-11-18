import type { Parcel, RateOffer, RateRequest, ShippingRateProvider } from "./types";
import { chargeableGramsTotal } from "./parcels";

/**
 * ⚠️ DEMO. Singurul loc din aplicație cu tarife de livrare demonstrative: NU sunt tarife reale ale vreunui curier. Furnizorul
 * fals de mai jos servește testele ȘI aplicația în Faza 9; curierii reali (Sameday, Dragonstar, Fan Courier …) vin prin
 * agregator în Faza 12, care implementează aceeași interfață `ShippingRateProvider`. Orice ofertă din acest fișier poartă
 * `demo: true`, iar etichetele ei conțin «DEMO», ca nimeni să nu o ia drept tarif real.
 */
export const DEMO_RATE_CARD = {
  courier: {
    carrier: "Curier DEMO",
    service: "Standard (DEMO)",
    baseMinor: 2_500,
    includedGrams: 5_000,
    perExtraKgMinor: 400,
    estimatedDays: 2,
    codFeeMinor: 500,
  },
  freight: {
    carrier: "Marfă DEMO",
    service: "Transport marfă (DEMO)",
    baseMinor: 15_000,
    includedGrams: 30_000,
    perExtraKgMinor: 250,
    estimatedDays: 4,
    codFeeMinor: 1_500,
  },
  easybox: {
    carrier: "Easybox DEMO",
    service: "Locker (DEMO)",
    baseMinor: 1_800,
    includedGrams: 5_000,
    perExtraKgMinor: 300,
    estimatedDays: 2,
    codFeeMinor: 500,
  },
  /** Ultima soluție, când nici furnizorul, nici zonele din admin nu dau o ofertă: checkout-ul nu se blochează niciodată. */
  lastResort: {
    carrier: "Curier DEMO",
    service: "Livrare standard (tarif provizoriu DEMO)",
    priceMinor: 3_000,
    estimatedDays: 3,
    codFeeMinor: 500,
  },
} as const;

interface RateCard {
  carrier: string;
  service: string;
  baseMinor: number;
  includedGrams: number;
  perExtraKgMinor: number;
  estimatedDays: number;
  codFeeMinor: number;
}

function tierPrice(tier: RateCard, chargeableGrams: number): number {
  const extraKg = Math.ceil(Math.max(0, chargeableGrams - tier.includedGrams) / 1000);
  return tier.baseMinor + extraKg * tier.perExtraKgMinor;
}

const hasHeavy = (parcels: readonly Parcel[]): boolean =>
  parcels.some((p) => p.shippingClass !== "standard");

/** Oferta de ultimă instanță (DEMO), folosită doar de `ShippingService` când nu există nicio altă ofertă. */
export function lastResortOffer(): RateOffer {
  const card = DEMO_RATE_CARD.lastResort;
  return {
    code: "demo:last-resort",
    kind: "courier",
    carrier: card.carrier,
    service: card.service,
    priceMinor: card.priceMinor,
    estimatedDays: card.estimatedDays,
    codFeeMinor: card.codFeeMinor,
    source: "last_resort",
    demo: true,
    freeShipping: false,
  };
}

/** Furnizorul fals de tarife: valorile vin din `DEMO_RATE_CARD`. Produsele voluminoase merg doar pe marfă și nu la easybox. */
export class DemoShippingRateProvider implements ShippingRateProvider {
  readonly name = "demo";

  async quote(request: RateRequest): Promise<RateOffer[]> {
    const grams = chargeableGramsTotal(request.parcels);
    const offer = (code: string, kind: RateOffer["kind"], card: RateCard): RateOffer => ({
      code,
      kind,
      carrier: card.carrier,
      service: card.service,
      priceMinor: tierPrice(card, grams),
      estimatedDays: card.estimatedDays,
      codFeeMinor: card.codFeeMinor,
      source: "provider",
      demo: true,
      freeShipping: false,
    });
    if (hasHeavy(request.parcels)) {
      return [offer("demo:freight", "courier", DEMO_RATE_CARD.freight)];
    }
    return [
      offer("demo:courier", "courier", DEMO_RATE_CARD.courier),
      offer("demo:easybox", "easybox", DEMO_RATE_CARD.easybox),
    ];
  }
}
