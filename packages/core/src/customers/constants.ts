/**
 * Grupurile de clienți (Faza 15, docs/09). «Client standard» e grupul de sistem (default de pachet): `none`, neștergibil. Celelalte
 * grupuri sunt un seed specific magazinului (`store-groups.ts`), editabile din admin.
 */
export const SYSTEM_GROUP_SLUG = "client-standard";
export const SYSTEM_GROUP_NAME = "Client standard";

export const PRICING_TYPES = ["none", "discount", "cost_plus"] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

/** Tonurile badge-ului (tonurile pastilei din design system; baza de date mai acceptă și «accent», nefolosit). */
export const GROUP_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type GroupTone = (typeof GROUP_TONES)[number];

/** Limite în puncte de bază (baza de date le verifică la fel). */
export const MAX_DISCOUNT_BPS = 10_000;
export const MAX_MARKUP_BPS = 1_000_000;
