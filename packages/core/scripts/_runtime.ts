import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
import { BRANDING_CACHE_KEY } from "../src/branding/branding-service";
import { FEATURE_FLAGS_CACHE_KEY } from "../src/features/feature-flag-service";
import { SETTINGS_CACHE_KEY } from "../src/settings/settings-service";

/** Încarcă .env-ul din rădăcina repo-ului (scripturile rulează din packages/*). */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // fără .env: variabilele vin din mediu
  }
}

/** Șterge cache-urile Redis ale configurării (best-effort: fără Redis, scriptul merge mai departe). */
export async function invalidateConfigCaches(): Promise<boolean> {
  const url = process.env["REDIS_URL"];
  if (!url) return false;
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.del(SETTINGS_CACHE_KEY, FEATURE_FLAGS_CACHE_KEY, BRANDING_CACHE_KEY);
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export { getDb };
