import { ValidationError } from "@ecom/shared";
import { invalidateCache, readThrough, type KeyValueCache } from "../cache/read-through";
import { FEATURE_FLAGS, FEATURE_KEYS, isFeatureKey, type FeatureKey } from "./registry";

/** Ce îi trebuie serviciului din baza de date (satisfăcut de Prisma și de fake-uri de test). */
export interface FeatureFlagStore {
  loadAll(): Promise<{ key: string; enabled: boolean }[]>;
  upsert(row: { key: string; enabled: boolean; description: string }): Promise<void>;
}

export const FEATURE_FLAGS_CACHE_KEY = "ecom:feature-flags:v1";
export const FEATURE_FLAGS_CACHE_TTL_SECONDS = 300;

export interface FeatureFlagState {
  key: FeatureKey;
  label: string;
  enabled: boolean;
}

export class FeatureFlagService {
  constructor(
    private readonly store: FeatureFlagStore,
    private readonly cache: KeyValueCache,
  ) {}

  /** `true` doar dacă flag-ul există în DB și e pornit. Flag lipsă = oprit. */
  async isEnabled(key: FeatureKey): Promise<boolean> {
    this.assertKnown(key);
    return (await this.loadMap())[key] === true;
  }

  async list(): Promise<FeatureFlagState[]> {
    const map = await this.loadMap();
    return FEATURE_KEYS.map((key) => ({
      key,
      label: FEATURE_FLAGS[key],
      enabled: map[key] === true,
    }));
  }

  /** Scrie flag-ul și invalidează cache-ul. `auditLog()` se leagă la nivelul server action-ului. */
  async setEnabled(key: FeatureKey, enabled: boolean): Promise<void> {
    this.assertKnown(key);
    await this.store.upsert({ key, enabled, description: FEATURE_FLAGS[key] });
    await this.invalidate();
  }

  async invalidate(): Promise<void> {
    await invalidateCache(this.cache, FEATURE_FLAGS_CACHE_KEY, "flag-uri");
  }

  private assertKnown(key: string): asserts key is FeatureKey {
    if (!isFeatureKey(key)) throw new ValidationError(`Flag necunoscut: ${key}`, { key });
  }

  private loadMap(): Promise<Record<string, boolean>> {
    return readThrough({
      cache: this.cache,
      key: FEATURE_FLAGS_CACHE_KEY,
      ttlSeconds: FEATURE_FLAGS_CACHE_TTL_SECONDS,
      label: "flag-uri",
      load: async () => {
        const rows = await this.store.loadAll();
        const map: Record<string, boolean> = {};
        // Rândurile cu chei necunoscute (flag scos dintr-o versiune nouă) se ignoră.
        for (const row of rows) if (isFeatureKey(row.key)) map[row.key] = row.enabled;
        return map;
      },
    });
  }
}
