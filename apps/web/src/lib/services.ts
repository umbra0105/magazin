import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  FeatureFlagService,
  SettingsService,
  createPrismaFeatureFlagStore,
  createPrismaSettingsStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";

const globalForServices = globalThis as unknown as {
  __ecomRedis?: Redis;
  __ecomSettings?: SettingsService;
  __ecomFeatureFlags?: FeatureFlagService;
};

/** Un singur client Redis per proces (reutilizat la hot reload în dev). */
export function getRedis(): Redis {
  if (!globalForServices.__ecomRedis) {
    globalForServices.__ecomRedis = new Redis(loadEnv().REDIS_URL, {
      maxRetriesPerRequest: 1,
    });
    // Fără handler, o eroare de conexiune ar opri procesul; SettingsService cade oricum pe DB.
    globalForServices.__ecomRedis.on("error", () => undefined);
  }
  return globalForServices.__ecomRedis;
}

export function getSettings(): SettingsService {
  if (!globalForServices.__ecomSettings) {
    globalForServices.__ecomSettings = new SettingsService(
      createPrismaSettingsStore(getDb()),
      getRedis(),
    );
  }
  return globalForServices.__ecomSettings;
}

export function getFeatureFlags(): FeatureFlagService {
  if (!globalForServices.__ecomFeatureFlags) {
    globalForServices.__ecomFeatureFlags = new FeatureFlagService(
      createPrismaFeatureFlagStore(getDb()),
      getRedis(),
    );
  }
  return globalForServices.__ecomFeatureFlags;
}
