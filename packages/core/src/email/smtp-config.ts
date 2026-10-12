import { z } from "zod";
import type { IntegrationService } from "../integrations/integration-service";
import type { SettingsService } from "../settings/settings-service";

/** `Integration` cu `type = "email"`, `provider = "smtp"`. */
export const SMTP_INTEGRATION = { type: "email", provider: "smtp" } as const;

/** Partea ne-secretă (în `Integration.config`). Parola stă criptată în `credentials`. */
export const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** TLS direct (portul 465). Pe 587 se folosește STARTTLS, `secure = false`. */
  secure: z.boolean().default(false),
  /** Utilizatorul SMTP, dacă serverul cere autentificare. */
  user: z.string().optional(),
});

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  fromName: string;
  fromAddress: string;
  replyTo?: string;
}

export class EmailNotConfiguredError extends Error {
  readonly code = "EMAIL_NOT_CONFIGURED";
  constructor(reason: string) {
    super(`Emailul nu e configurat: ${reason}`);
    this.name = "EmailNotConfiguredError";
  }
}

/**
 * Configurația de trimitere: serverul SMTP din `Integration` (parola criptată cu `APP_KEY`) și
 * expeditorul din setările `email.*`. Întoarce `null` dacă integrarea lipsește sau e inactivă;
 * aruncă `EmailNotConfiguredError` dacă e activă dar incompletă (fără expeditor / host).
 */
export async function loadMailerConfig(deps: {
  integrations: IntegrationService;
  settings: SettingsService;
}): Promise<MailerConfig | null> {
  const view = await deps.integrations.getPublicView(
    SMTP_INTEGRATION.type,
    SMTP_INTEGRATION.provider,
  );
  if (!view?.isActive) return null;

  const parsed = smtpConfigSchema.safeParse(view.config);
  if (!parsed.success) throw new EmailNotConfiguredError("setările SMTP sunt invalide");

  const email = await deps.settings.getGroup("email");
  if (!email.fromAddress) throw new EmailNotConfiguredError("lipsește adresa expeditorului");

  const credentials = await deps.integrations.getCredentials(
    SMTP_INTEGRATION.type,
    SMTP_INTEGRATION.provider,
  );
  const password = credentials?.["password"];
  return {
    host: parsed.data.host,
    port: parsed.data.port,
    secure: parsed.data.secure,
    ...(parsed.data.user && { user: parsed.data.user }),
    ...(password && { password }),
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    ...(email.replyTo && { replyTo: email.replyTo }),
  };
}
