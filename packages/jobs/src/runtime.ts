import { Redis } from "ioredis";
import { loadEnv } from "@ecom/config";
import {
  BrandingService,
  FONT_FAMILIES,
  IntegrationService,
  RADIUS_VALUES,
  SettingsService,
  createPrismaBrandingStore,
  createPrismaIntegrationStore,
  createPrismaSettingsStore,
  loadMailerConfig,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import { getLogger } from "@ecom/shared";
import type { EmailProcessorDeps } from "./email-processor";
import { sendViaSmtp } from "./mailer";
import { startEmailWorker } from "./worker";

const SANS_STACK = "Arial, Helvetica, sans-serif";
const SERIF_STACK = "Georgia, 'Times New Roman', serif";

/** Linkul către un fișier din admin (cale relativă) devine absolut cu originea din `APP_URL`. */
function absoluteUrl(appUrl: string, value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, new URL(appUrl).origin).toString();
  } catch {
    return null;
  }
}

/**
 * Dependențele reale ale workerului: configurația SMTP din `Integration` (parola decriptată doar
 * aici, în memorie), expeditorul din setări, tema din `Branding` (culorile paletei luminoase).
 */
export function createEmailRuntime(): {
  deps: EmailProcessorDeps;
  redisUrl: string;
  close(): void;
} {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // cache-ul cade pe DB; fără handler un eșec ar opri procesul
  const db = getDb();
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const branding = new BrandingService(createPrismaBrandingStore(db), redis);
  const integrations = new IntegrationService(createPrismaIntegrationStore(db), env.APP_KEY);

  const deps: EmailProcessorDeps = {
    appKey: env.APP_KEY,
    appUrl: env.APP_URL,
    loadMailer: () => loadMailerConfig({ integrations, settings }),
    async loadTheme(): Promise<EmailTheme> {
      const [config, storeName] = await Promise.all([
        branding.getConfig(),
        settings.get("general.storeName"),
      ]);
      const c = config.colors.light;
      const remToPx = (rem: string) => Math.round(Number.parseFloat(rem) * 16) || 0;
      return {
        storeName,
        logoUrl: absoluteUrl(env.APP_URL, config.logoUrl),
        colors: {
          bg: c.bg,
          fg: c.fg,
          muted: c.muted,
          border: c.border,
          primary: c.primary,
          primaryFg: c.primaryFg,
        },
        fontFamily: FONT_FAMILIES[config.fonts.body].kind === "serif" ? SERIF_STACK : SANS_STACK,
        radiusPx: remToPx(RADIUS_VALUES[config.radius]),
      };
    },
    sendMail: sendViaSmtp,
    logger: getLogger(),
  };
  return { deps, redisUrl: env.REDIS_URL, close: () => redis.disconnect() };
}

/** Pornește workerul cu dependențele reale (din mediu). Folosit de `pnpm worker` și de `pnpm dev:web`. */
export function startEmailWorkerFromEnv() {
  const runtime = createEmailRuntime();
  const worker = startEmailWorker({
    redisUrl: runtime.redisUrl,
    deps: runtime.deps,
    logger: getLogger(),
  });
  return {
    worker,
    async close() {
      await worker.close();
      runtime.close();
    },
  };
}
