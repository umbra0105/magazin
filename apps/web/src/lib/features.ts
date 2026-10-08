import { notFound } from "next/navigation";
import { createFeatureGuard } from "./feature-guard";
import { getFeatureFlags } from "./services";

/**
 * Folosire într-o rută a unei funcționalități opționale (ex. `app/(storefront)/blog/layout.tsx`):
 *
 *   await requireFeature("blog");                          // 404 dacă blogul e oprit
 *   const { BlogIndex } = await loadFeature("blog", () => import("@/features/blog"));
 */
export const { requireFeature, loadFeature } = createFeatureGuard({
  isEnabled: (key) => getFeatureFlags().isEnabled(key),
  notFound,
});

export { isFeatureKey, type FeatureKey } from "@ecom/core";
