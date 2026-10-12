import { UnrecoverableError } from "bullmq";
import {
  buildResetPasswordLink,
  buildVerifyEmailLink,
  openEmailPayload,
  redactSecrets,
  type EmailPayload,
  type MailerConfig,
  type SealedEmailJob,
} from "@ecom/core";
import { renderEmail, type EmailTheme } from "@ecom/emails";

export interface OutgoingMessage {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface EmailProcessorDeps {
  appKey: string;
  /** URL-ul public al aplicației (`APP_URL`); linkurile se construiesc DOAR din el. */
  appUrl: string;
  loadMailer(): Promise<MailerConfig | null>;
  loadTheme(): Promise<EmailTheme>;
  sendMail(config: MailerConfig, message: OutgoingMessage): Promise<void>;
  logger: JobLogger;
}

export interface EmailJobLike {
  id?: string | undefined;
  data: SealedEmailJob;
  attemptsMade: number;
}

const linkFor = (payload: EmailPayload, appUrl: string): string =>
  payload.kind === "verify-email"
    ? buildVerifyEmailLink(appUrl, payload.token)
    : buildResetPasswordLink(appUrl, payload.token);

/**
 * Procesorul joburilor de email. Reguli de confidențialitate:
 *  - în loguri intră DOAR `jobId`, tipul și numărul încercării; niciodată tokenul, linkul,
 *    destinatarul sau corpul;
 *  - mesajul unei erori (SMTP, rețea) trece prin `redactSecrets` înainte să fie aruncat, deci nici
 *    `failedReason`-ul păstrat de BullMQ în Redis nu conține valori sensibile.
 * Erorile permanente (payload alterat, email neconfigurat) nu se reîncearcă (`UnrecoverableError`).
 */
export function createEmailProcessor(deps: EmailProcessorDeps) {
  return async function process(job: EmailJobLike): Promise<void> {
    const jobId = job.id ?? "?";
    const kind = job.data.kind;

    let payload: EmailPayload;
    try {
      payload = openEmailPayload(deps.appKey, job.data);
    } catch {
      deps.logger.error({ jobId, kind }, "email: payload invalid sau alterat, renunț");
      throw new UnrecoverableError("EMAIL_PAYLOAD_INVALID");
    }

    const link = linkFor(payload, deps.appUrl);
    const secrets = [payload.token, link, payload.to, payload.name];
    try {
      const mailer = await deps.loadMailer();
      if (!mailer) {
        deps.logger.warn({ jobId, kind }, "email: SMTP neconfigurat sau inactiv, renunț");
        throw new UnrecoverableError("EMAIL_NOT_CONFIGURED");
      }
      const theme = await deps.loadTheme();
      const rendered = await renderEmail(
        theme,
        payload.kind === "verify-email"
          ? { kind: payload.kind, name: payload.name, link, validForHours: payload.validForHours }
          : {
              kind: payload.kind,
              name: payload.name,
              link,
              validForMinutes: payload.validForMinutes,
            },
      );
      secrets.push(rendered.html, rendered.text);
      await deps.sendMail(mailer, {
        from: { name: mailer.fromName, address: mailer.fromAddress },
        to: payload.to,
        ...(mailer.replyTo && { replyTo: mailer.replyTo }),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      deps.logger.info({ jobId, kind, attempt: job.attemptsMade + 1 }, "email trimis");
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      const raw = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "SEND_FAILED";
      // Aruncăm o eroare NOUĂ, curățată: stiva și mesajul originale pot conține adresa sau corpul.
      throw Object.assign(new Error(`${code}: ${redactSecrets(raw, secrets)}`), {
        name: "EmailSendError",
      });
    }
  };
}
