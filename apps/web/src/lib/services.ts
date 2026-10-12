import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  AuditService,
  AuthGuard,
  BrandingService,
  MemoryCounterStore,
  RedisCounterStore,
  ResilientCounterStore,
  createPrismaAuditStore,
  createAuth,
  createRedisSecondaryStorage,
  deriveKey,
  type Auth,
  FeatureFlagService,
  SettingsService,
  createPrismaBrandingStore,
  createPrismaFeatureFlagStore,
  createPrismaSettingsStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createAuthEmailSender } from "./email";
import { getLogger } from "@ecom/shared";

const globalForServices = globalThis as unknown as {
  __ecomRedis?: Redis;
  __ecomSettings?: SettingsService;
  __ecomFeatureFlags?: FeatureFlagService;
  __ecomBranding?: BrandingService;
  __ecomAuthMemory?: MemoryCounterStore;
  __ecomAuth?: { auth: Auth; fingerprint: string };
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

export function getBranding(): BrandingService {
  if (!globalForServices.__ecomBranding) {
    globalForServices.__ecomBranding = new BrandingService(
      createPrismaBrandingStore(getDb()),
      getRedis(),
    );
  }
  return globalForServices.__ecomBranding;
}

/**
 * Contoarele din memorie se păstrează între reconstruirile instanței Better Auth (la schimbarea
 * setărilor), ca limitele și blocările puse cât Redis era căzut să nu se piardă în același proces.
 */
function getCounterStore(): ResilientCounterStore {
  globalForServices.__ecomAuthMemory ??= new MemoryCounterStore();
  return new ResilientCounterStore(
    new RedisCounterStore(getRedis()),
    globalForServices.__ecomAuthMemory,
    getLogger(),
  );
}

const AUTH_SECRET_LABEL = "ecom/auth-secret/v1";

/**
 * Instanța Better Auth. Politica (sesiuni, parole, verificare email) vine din setările `auth.*`;
 * dacă se schimbă, instanța se reconstruiește la următoarea cerere (setările sunt în cache Redis).
 */
export async function getAuth(): Promise<Auth> {
  const settings = await getSettings().getGroup("auth");
  const fingerprint = JSON.stringify(settings);
  const cached = globalForServices.__ecomAuth;
  if (cached && cached.fingerprint === fingerprint) return cached.auth;

  const env = loadEnv();
  const auth = createAuth({
    db: getDb(),
    secondaryStorage: createRedisSecondaryStorage(getRedis()),
    appUrl: env.APP_URL,
    secret: deriveKey(env.APP_KEY, AUTH_SECRET_LABEL).toString("base64"),
    isProduction: env.NODE_ENV === "production",
    settings,
    guard: new AuthGuard(getCounterStore(), settings),
    email: createAuthEmailSender(),
    onAccountLocked: async ({ email, lockoutMinutes }) => {
      // Se auditează doar conturile reale; jurnalul nu e vizibil din exterior, deci nu dă indicii.
      const user = await getDb().user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (!user) return;
      await new AuditService(createPrismaAuditStore(getDb())).record({
        actorId: "system",
        actorLabel: "system",
        action: "auth.account_locked",
        entity: "user",
        entityId: user.id,
        after: { lockoutMinutes },
      });
    },
  });
  globalForServices.__ecomAuth = { auth, fingerprint };
  return auth;
}
