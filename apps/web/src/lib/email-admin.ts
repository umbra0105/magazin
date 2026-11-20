import { loadEnv } from "@ecom/config";
import {
  IntegrationService,
  SMTP_INTEGRATION,
  createPrismaIntegrationStore,
  loadMailerConfig,
  smtpConfigSchema,
  type MailerConfig,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { buildEmailTheme, type EmailTheme } from "@ecom/jobs";
import { getBranding, getSettings } from "./services";

/**
 * Ajutoare pentru ecranele de email din admin (Faza 11): serviciul de integrări (parola SMTP criptată cu `APP_KEY`), starea
 * SMTP FĂRĂ parolă, configurația de trimitere și tema emailurilor. Parola nu iese niciodată din aici spre interfață.
 */
export function getIntegrations(): IntegrationService {
  return new IntegrationService(createPrismaIntegrationStore(getDb()), loadEnv().APP_KEY);
}

export interface SmtpState {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  isActive: boolean;
  /** Parola e salvată (nu se afișează; doar «Salvat»). */
  passwordSaved: boolean;
  exists: boolean;
}

export async function loadSmtpState(): Promise<SmtpState> {
  const view = await getIntegrations().getPublicView(
    SMTP_INTEGRATION.type,
    SMTP_INTEGRATION.provider,
  );
  const parsed = smtpConfigSchema.safeParse(view?.config ?? {});
  const config = parsed.success ? parsed.data : null;
  return {
    host: config?.host ?? "",
    port: config?.port ?? 587,
    secure: config?.secure ?? false,
    user: config?.user ?? "",
    isActive: view?.isActive ?? false,
    passwordSaved: Boolean(view?.credentials["password"]),
    exists: view !== null,
  };
}

/** Configurația de trimitere (cu parola decriptată, doar pe server, pentru testul de conexiune și emailul de test) sau `null`. */
export async function currentMailer(): Promise<MailerConfig | null> {
  try {
    return await loadMailerConfig({ integrations: getIntegrations(), settings: getSettings() });
  } catch {
    return null;
  }
}

export async function currentTheme(): Promise<EmailTheme> {
  const [config, storeName] = await Promise.all([
    getBranding().getConfig(),
    getSettings().get("general.storeName"),
  ]);
  return buildEmailTheme(config, storeName, loadEnv().APP_URL);
}
