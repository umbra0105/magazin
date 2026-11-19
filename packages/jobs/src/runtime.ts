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
import type { BrandingConfig } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { createBackInStockService } from "./back-in-stock-runtime";
import { createOrderEmailDelivery } from "./order-email-delivery";
import type { StoreEmailSettings } from "./order-email-context";
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
/** Tema emailurilor din `Branding` (culorile paletei luminoase, rezolvate în valori fixe, fiindcă emailul nu are CSS variables). */
export function buildEmailTheme(
  config: BrandingConfig,
  storeName: string,
  appUrl: string,
): EmailTheme {
  const c = config.colors.light;
  const remToPx = (rem: string) => Math.round(Number.parseFloat(rem) * 16) || 0;
  return {
    storeName,
    logoUrl: absoluteUrl(appUrl, config.logoUrl),
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
}

/** Setările magazinului de care au nevoie emailurile comenzilor (datele firmei, linkurile legale, formatul regional). */
export async function loadStoreEmailSettings(
  settings: SettingsService,
): Promise<StoreEmailSettings> {
  const [general, company, legal, regional] = await Promise.all([
    settings.getGroup("general"),
    settings.getGroup("company"),
    settings.getGroup("legal"),
    settings.getGroup("regional"),
  ]);
  return {
    storeName: general.storeName,
    currency: regional.currency,
    locale: regional.locale,
    timeZone: regional.timezone,
    company: {
      legalName: company.legalName,
      vatId: company.vatId,
      tradeRegisterNo: company.tradeRegisterNo,
      address: company.address,
      email: company.email,
      phone: company.phone,
      iban: company.iban,
      bankName: company.bankName,
    },
    legal: { anpcUrl: legal.anpcUrl, salUrl: legal.salUrl, odrUrl: legal.odrUrl },
  };
}

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
      return buildEmailTheme(config, storeName, env.APP_URL);
    },
    sendMail: sendViaSmtp,
    logger: getLogger(),
    backInStock: createBackInStockService(db, settings),
    orderEmail: createOrderEmailDelivery({
      db,
      appUrl: env.APP_URL,
      now: () => new Date(),
      loadMailer: () => loadMailerConfig({ integrations, settings }),
      loadTheme: async () => {
        const [config, storeName] = await Promise.all([
          branding.getConfig(),
          settings.get("general.storeName"),
        ]);
        return buildEmailTheme(config, storeName, env.APP_URL);
      },
      loadStore: () => loadStoreEmailSettings(settings),
      loadOverride: async (template) => {
        const row = await db.emailTemplateOverride.findUnique({ where: { template } });
        return row ? { subject: row.subject, intro: row.intro } : null;
      },
      sendMail: sendViaSmtp,
      logger: getLogger(),
    }),
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
