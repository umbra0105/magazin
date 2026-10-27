import { UnrecoverableError } from "bullmq";
import {
  buildProductLink,
  buildResetPasswordLink,
  buildVerifyEmailLink,
  openEmailPayload,
  redactSecrets,
  type ClaimResult,
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

/** Ce îi trebuie procesorului de la serviciul «Anunță-mă când revine» (`BackInStockService` îl satisface). */
export interface BackInStockDelivery {
  claim(alertId: string): Promise<ClaimResult>;
  release(alertId: string): Promise<boolean>;
  complete(alertId: string): Promise<boolean>;
}

export interface EmailProcessorDeps {
  appKey: string;
  /** URL-ul public al aplicației (`APP_URL`); linkurile se construiesc DOAR din el. */
  appUrl: string;
  loadMailer(): Promise<MailerConfig | null>;
  loadTheme(): Promise<EmailTheme>;
  sendMail(config: MailerConfig, message: OutgoingMessage): Promise<void>;
  logger: JobLogger;
  /** Doar pentru emailurile «Anunță-mă»; fără el, un astfel de job eșuează definitiv. */
  backInStock?: BackInStockDelivery;
}

export interface EmailJobLike {
  id?: string | undefined;
  data: SealedEmailJob;
  attemptsMade: number;
}

type TokenPayload = Exclude<EmailPayload, { kind: "back-in-stock" }>;

const linkFor = (payload: TokenPayload, appUrl: string): string =>
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
  /**
   * «Anunță-mă când revine»: jobul poartă DOAR identificatorul cererii; adresa se citește din baza de date la `claim`, deci nu
   * ajunge niciodată în Redis. Ordinea: SMTP configurat → claim atomic → randare → trimitere → ștergerea cererii.
   *  - cererea luată de altcineva sau dispărută, ori stocul epuizat din nou: nimic de trimis, jobul se încheie;
   *  - randarea sau trimiterea eșuează: cererea revine în așteptare (`release`) și eroarea curățată se aruncă, ca BullMQ să reîncerce;
   *  - ștergerea eșuează DUPĂ trimitere: nu se aruncă (o reîncercare ar însemna un al doilea email); cererea rămâne «luată»
   *    și o șterge curățarea de siguranță.
   */
  async function processBackInStock(
    alertId: string,
    jobId: string,
    attemptsMade: number,
  ): Promise<void> {
    const kind = "back-in-stock";
    const delivery = deps.backInStock;
    if (!delivery) {
      deps.logger.error(
        { jobId, kind },
        "email: serviciul «Anunță-mă» lipsește din worker, renunț",
      );
      throw new UnrecoverableError("EMAIL_NOT_CONFIGURED");
    }
    const mailer = await deps.loadMailer();
    if (!mailer) {
      deps.logger.warn({ jobId, kind }, "email: SMTP neconfigurat sau inactiv, renunț");
      throw new UnrecoverableError("EMAIL_NOT_CONFIGURED");
    }
    const claim = await delivery.claim(alertId);
    if (claim.status !== "claimed") {
      deps.logger.info({ jobId, kind, outcome: claim.status }, "email: nimic de trimis");
      return;
    }
    const { alert } = claim;
    const link = buildProductLink(deps.appUrl, alert.productSlug);
    const secrets = [alert.email, alert.productTitle, link];
    try {
      const theme = await deps.loadTheme();
      const rendered = await renderEmail(theme, {
        kind,
        productTitle: alert.productTitle,
        variantLabel: alert.variantLabel,
        link,
      });
      secrets.push(rendered.html, rendered.text);
      await deps.sendMail(mailer, {
        from: { name: mailer.fromName, address: mailer.fromAddress },
        to: alert.email,
        ...(mailer.replyTo && { replyTo: mailer.replyTo }),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch (error) {
      try {
        await delivery.release(alertId);
      } catch {
        deps.logger.error({ jobId, kind }, "email: nu am putut readuce cererea în așteptare");
      }
      const raw = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "SEND_FAILED";
      throw Object.assign(new Error(`${code}: ${redactSecrets(raw, secrets)}`), {
        name: "EmailSendError",
      });
    }
    try {
      await delivery.complete(alertId);
    } catch {
      deps.logger.warn(
        { jobId, kind },
        "email trimis, dar cererea nu s-a putut șterge acum (o șterge curățarea de siguranță)",
      );
    }
    deps.logger.info({ jobId, kind, attempt: attemptsMade + 1 }, "email trimis");
  }

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

    if (payload.kind === "back-in-stock") {
      await processBackInStock(payload.alertId, jobId, job.attemptsMade);
      return;
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
