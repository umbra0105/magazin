import type { FeatureKey } from "@ecom/core";

export interface FeatureGuardDeps {
  isEnabled: (key: FeatureKey) => Promise<boolean>;
  /** `notFound` din next/navigation: aruncă și oprește randarea cu 404. */
  notFound: () => never;
}

/**
 * Gardă pentru funcționalitățile opționale.
 *
 * - `requireFeature(key)`: flag stins → 404.
 * - `loadFeature(key, () => import("..."))`: verifică flag-ul ÎNAINTE de import, deci codul
 *   funcției nu se încarcă (și, fiind import dinamic, are chunk separat) când flag-ul e stins.
 */
export function createFeatureGuard({ isEnabled, notFound }: FeatureGuardDeps) {
  async function requireFeature(key: FeatureKey): Promise<void> {
    if (!(await isEnabled(key))) notFound();
  }

  async function loadFeature<T>(key: FeatureKey, loader: () => Promise<T>): Promise<T> {
    await requireFeature(key);
    return loader();
  }

  return { requireFeature, loadFeature };
}
