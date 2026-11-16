import { effectivePrice } from "../catalog/catalog-support";

/**
 * Prețul afișat în vitrină, FĂRĂ motor de prețuri (Faza 8): doar câmpurile publice ale variantei (`price`, `salePrice` și
 * fereastra promoției), niciodată costul. Sumele sunt `int` în bani. Cu `showSale = false` (setarea
 * `catalog.showSalePricing`, oprită implicit până la răspunsul avocatului despre Omnibus, `docs/INTREBARI-AVOCAT.md` §2) vitrina
 * nu arată nicio reducere: nici preț redus, nici preț tăiat, doar prețul întreg.
 */

export interface PricedVariant {
  price: number;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

export interface DisplayedPrice {
  amount: number;
  /** Prețul întreg tăiat, doar când reducerea e activă ȘI afișarea reducerilor e pornită; altfel `null`. */
  compareAt: number | null;
}

export function displayedPrice(
  variant: PricedVariant,
  at: Date,
  showSale: boolean,
): DisplayedPrice {
  if (!showSale) return { amount: variant.price, compareAt: null };
  const amount = effectivePrice(variant, at);
  return { amount, compareAt: amount < variant.price ? variant.price : null };
}

export interface ListingPrice extends DisplayedPrice {
  /** Variantele au prețuri diferite: cardul arată «de la» cel mai mic preț (și nu arată preț tăiat). */
  isRange: boolean;
}

export function listingPrice(
  variants: readonly PricedVariant[],
  at: Date,
  showSale: boolean,
): ListingPrice | null {
  if (variants.length === 0) return null;
  const shown = variants.map((variant) => displayedPrice(variant, at, showSale));
  let lowest = shown[0] as DisplayedPrice;
  for (const price of shown) if (price.amount < lowest.amount) lowest = price;
  const isRange = shown.some((price) => price.amount !== lowest.amount);
  return { amount: lowest.amount, compareAt: isRange ? null : lowest.compareAt, isRange };
}
