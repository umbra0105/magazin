/**
 * Funcționalitățile opționale. TOATE sunt oprite implicit în pachet; un magazin le pornește
 * din admin sau din seed-ul lui specific. Un flag fără rând în DB înseamnă oprit.
 */
export const FEATURE_FLAGS = {
  blog: "Blog",
  reviews: "Recenzii produse",
  wishlist: "Listă de dorințe",
  multiWarehouse: "Multi-depozit",
  loyalty: "Puncte de loialitate",
  vouchers: "Vouchere cadou",
} as const;

export type FeatureKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_KEYS = Object.keys(FEATURE_FLAGS) as FeatureKey[];

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.hasOwn(FEATURE_FLAGS, key);
}
