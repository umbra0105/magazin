import type { Parcel, RateOffer } from "./types";

/**
 * Transportul paletizat (Faza 12, deciziile utilizatorului din 2026-11-22). Preț FIX per palet, cu TVA inclus, din setări
 * (`shipping.palletPriceMinor`, implicit 35.000 bani = 350 lei); NU vine din API. Un singur mod de transport pe comandă,
 * calculat pe TOATE liniile fizice.
 *
 * Când se oferă:
 *  (a) cel puțin o linie `shippingClass = pallet` → DOAR paletizat (fără curier standard, fără easybox);
 *  (b) altfel, dacă cel mai ieftin curier (preț brut, cu TVA, ÎNAINTE de scutirea de transport gratuit) DEPĂȘEȘTE pragul
 *      `shipping.palletSwitchThresholdMinor` (implicit 400 lei, comparație strictă) ȘI paletizatul costă mai puțin sau cât
 *      curierul → curierul și easybox-ul se ascund; dacă paletizatul ar costa MAI MULT, curierul rămâne;
 *  (c) furnizorul a REFUZAT tariful (greutate sau dimensiuni peste limita lui) și nu există nicio altă ofertă de curier →
 *      se oferă paletizatul.
 * Ridicarea personală nu intră aici: rămâne mereu disponibilă (o adaugă `ShippingService`).
 *
 * Numărul de paleți = ⌈max(greutate totală ÷ capacitatea în greutate, volum total ÷ capacitatea în volum)⌉, minim 1, cu
 * întregi (grame și cm³), fără `float`. Produsele diferite se amestecă pe același palet: NU se modelează împachetarea reală,
 * ci o estimare după greutatea și volumul totale (simplificare declarată). O linie `pallet` fără greutate sau dimensiuni
 * contează prudent 1 palet pe bucată; o linie standard fără date doar e marcată «incompletă» și nu adaugă paleți.
 */

export const PALLET_OFFER_CODE = "pallet";

export interface PalletSettings {
  /** `shipping.palletPriceMinor`: prețul unui palet, în bani, cu TVA inclus. */
  priceMinor: number;
  /** `shipping.palletSwitchThresholdMinor`: peste acest preț de curier (bani, cu TVA) se compară cu paletizatul. */
  switchThresholdMinor: number;
  /** `shipping.palletMaxWeightGrams`: capacitatea unui palet în greutate, în grame. */
  maxWeightGrams: number;
  /** `shipping.palletMaxVolumeCm3`: capacitatea unui palet în volum, în cm³. */
  maxVolumeCm3: number;
}

/** Valorile implicite (2026-11-22): 350 lei per palet, prag 400 lei, 600 kg și 1,2 m³ per palet; oglinda registrului de setări. */
export const DEFAULT_PALLET_SETTINGS: PalletSettings = {
  priceMinor: 35_000,
  switchThresholdMinor: 40_000,
  maxWeightGrams: 600_000,
  maxVolumeCm3: 1_200_000,
};

function ceilDiv(numerator: number, divisor: number): number {
  const safe = Math.max(1, Math.trunc(divisor));
  return Math.floor((numerator + safe - 1) / safe);
}

/** Estimarea numărului de paleți pentru liniile fizice ale comenzii; cel puțin 1. */
export function palletCount(parcels: readonly Parcel[], settings: PalletSettings): number {
  let grams = 0;
  let cm3 = 0;
  let cautious = 0;
  for (const parcel of parcels) {
    const noData = parcel.incomplete || parcel.realGrams === 0 || parcel.volumeCm3 === 0;
    if (parcel.shippingClass === "pallet" && noData) {
      cautious += parcel.wholeUnits;
      continue;
    }
    grams += parcel.realGrams;
    cm3 += parcel.volumeCm3;
  }
  const estimated = Math.max(
    ceilDiv(grams, settings.maxWeightGrams),
    ceilDiv(cm3, settings.maxVolumeCm3),
  );
  const pooled = grams > 0 || cm3 > 0 ? estimated : 0;
  return Math.max(1, pooled + cautious);
}

/** Oferta paletizată: `pallets × preț per palet`, cu TVA inclus. `codFeeMinor` = taxa de ramburs a celui mai ieftin curier. */
export function palletOffer(
  pallets: number,
  settings: PalletSettings,
  codFeeMinor: number,
): RateOffer {
  return {
    code: PALLET_OFFER_CODE,
    kind: "pallet",
    carrier: "Transport paletizat",
    service: "marfă grea sau voluminoasă",
    priceMinor: pallets * settings.priceMinor,
    estimatedDays: null,
    codFeeMinor,
    source: "pallet",
    demo: false,
    freeShipping: false,
    pallets,
  };
}

export type PalletMode = "pallet_only" | "switched" | "refused" | "courier";

export interface PalletDecisionInput {
  parcels: readonly Parcel[];
  /** Ofertele de curier și easybox (de la furnizor sau din rezerva pe zone), cu prețul brut, ÎNAINTE de scutirea de transport. */
  offers: readonly RateOffer[];
  settings: PalletSettings;
  /** Furnizorul a refuzat tariful (greutate sau dimensiuni peste limita lui), nu doar a căzut. */
  providerRefused: boolean;
}

export interface PalletDecision {
  mode: PalletMode;
  offers: RateOffer[];
  /** Doar dacă a intervenit paletizatul: numărul de paleți estimat. */
  pallets: number | null;
}

const isCourierLike = (offer: RateOffer): boolean =>
  offer.kind === "courier" || offer.kind === "easybox";

export function decidePalletTransport(input: PalletDecisionInput): PalletDecision {
  const carriers = input.offers.filter(isCourierLike);
  const cheapestCourier = input.offers
    .filter((offer) => offer.kind === "courier")
    .reduce<RateOffer | null>(
      (best, offer) => (best === null || offer.priceMinor < best.priceMinor ? offer : best),
      null,
    );
  const codFee = cheapestCourier?.codFeeMinor ?? carriers[0]?.codFeeMinor ?? 0;
  const keep = input.offers.filter((offer) => !isCourierLike(offer));
  const unchanged: PalletDecision = { mode: "courier", offers: [...input.offers], pallets: null };

  if (input.parcels.some((parcel) => parcel.shippingClass === "pallet")) {
    const pallets = palletCount(input.parcels, input.settings);
    return {
      mode: "pallet_only",
      offers: [...keep, palletOffer(pallets, input.settings, codFee)],
      pallets,
    };
  }

  if (cheapestCourier === null) {
    if (!input.providerRefused || carriers.length > 0) return unchanged;
    const pallets = palletCount(input.parcels, input.settings);
    return {
      mode: "refused",
      offers: [...keep, palletOffer(pallets, input.settings, codFee)],
      pallets,
    };
  }

  if (cheapestCourier.priceMinor > input.settings.switchThresholdMinor) {
    const pallets = palletCount(input.parcels, input.settings);
    const offer = palletOffer(pallets, input.settings, codFee);
    if (offer.priceMinor <= cheapestCourier.priceMinor) {
      return { mode: "switched", offers: [...keep, offer], pallets };
    }
  }
  return unchanged;
}
