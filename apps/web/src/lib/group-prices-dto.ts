/**
 * Prețurile de grup pentru interfață (Faza 15): texte GATA formatate pe server (moneda și limba din setări), ca la coș. Conține doar
 * numele grupului, tipul lui, reducerea (la `discount`) și sume afișate; niciodată adaosul sau costul.
 */
export interface GroupPriceTexts {
  amountText: string;
  standardText: string;
}

export interface GroupPricesDto {
  /** `null` = oaspete, client fără grup sau grup fără preț special: nu se schimbă nimic în pagină. */
  group: { name: string; pricingType: "discount" | "cost_plus"; discountBps: number | null } | null;
  variants: Record<string, GroupPriceTexts>;
  products: Record<string, GroupPriceTexts & { isRange: boolean }>;
}

export const EMPTY_GROUP_PRICES: GroupPricesDto = { group: null, variants: {}, products: {} };
