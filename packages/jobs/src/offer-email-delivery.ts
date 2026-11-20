import { UnrecoverableError } from "bullmq";
import {
  buildOfferLink,
  hashOfferToken,
  loadOfferForEmail,
  recordOfferEmailFailure,
  redactSecrets,
  type Db,
  type MailerConfig,
} from "@ecom/core";
import { renderTemplateEmail, type EmailTheme, type TemplateOverride } from "@ecom/emails";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import type { DeliveryAttempt } from "./order-email-delivery";
import {
  formatDateTime,
  formatMoney,
  merchantOf,
  type StoreEmailSettings,
} from "./order-email-context";

/**
 * Trimiterea linkului unei oferte de plată (Faza 11). Jobul poartă, sigilate, id-ul ofertei, adresa și jetonul; restul se citește
 * din baza de date la trimitere. Reguli:
 *  - SMTP neconfigurat sau oferta dispărută: eșec/omitere fără reîncercare;
 *  - oferta nu mai e activă (anulată, expirată, plătită) sau jetonul a fost înlocuit de o retrimitere: nu se trimite (un link mort
 *    ar induce în eroare), jobul se încheie;
 *  - eșec la randare sau trimitere: se reîncearcă (BullMQ); la ULTIMA încercare oferta primește un eveniment și adminii o notificare
 *    (aceeași ofertă se poate retrimite din admin, cu link nou);
 *  - în loguri intră doar `jobId`, tipul și încercarea; niciodată adresa, jetonul sau linkul.
 */
export interface OfferEmailDeliveryDeps {
  db: Db;
  appUrl: string;
  now: () => Date;
  loadMailer(): Promise<MailerConfig | null>;
  loadTheme(): Promise<EmailTheme>;
  loadStore(): Promise<StoreEmailSettings>;
  loadOverride(template: string): Promise<TemplateOverride | null>;
  sendMail(config: MailerConfig, message: OutgoingMessage): Promise<void>;
  logger: JobLogger;
}

export interface OfferLinkJob {
  offerId: string;
  to: string;
  token: string;
}

export function createOfferEmailDelivery(deps: OfferEmailDeliveryDeps) {
  return async function deliver(job: OfferLinkJob, run: DeliveryAttempt): Promise<void> {
    const kind = "offer-link";
    let mailer: MailerConfig | null;
    try {
      mailer = await deps.loadMailer();
    } catch {
      mailer = null;
    }
    if (!mailer) {
      await recordOfferEmailFailure(
        deps.db,
        job.offerId,
        run.jobId,
        "SMTP neconfigurat sau inactiv",
      );
      deps.logger.warn({ jobId: run.jobId, kind }, "email ofertă: SMTP neconfigurat, renunț");
      throw new UnrecoverableError("EMAIL_NOT_CONFIGURED");
    }
    const offer = await loadOfferForEmail(deps.db, job.offerId);
    if (!offer) {
      deps.logger.info(
        { jobId: run.jobId, kind, outcome: "missing" },
        "email ofertă: nimic de trimis",
      );
      return;
    }
    if (offer.status !== "active" || offer.tokenHash !== hashOfferToken(job.token)) {
      deps.logger.info(
        { jobId: run.jobId, kind, outcome: "obsolete" },
        "email ofertă: link depășit, nu se trimite",
      );
      return;
    }
    const link = buildOfferLink(deps.appUrl, job.token);
    const secrets: string[] = [job.to, job.token, link];
    try {
      const store = await deps.loadStore();
      const [theme, override] = await Promise.all([
        deps.loadTheme(),
        deps.loadOverride("offer.payment_link"),
      ]);
      const vars: Record<string, string> = {
        magazin: store.storeName,
        client: offer.clientName,
        numar: offer.number,
        total: formatMoney(offer.totalMinor, store.currency, store.locale),
        expira: formatDateTime(offer.expiresAt, store.locale, store.timeZone),
        link,
      };
      const rendered = await renderTemplateEmail(
        theme,
        "offer.payment_link",
        { vars, merchant: merchantOf(store), legal: store.legal, order: null },
        { override },
      );
      secrets.push(rendered.html, rendered.text);
      await deps.sendMail(mailer, {
        from: { name: mailer.fromName, address: mailer.fromAddress },
        to: job.to,
        ...(mailer.replyTo && { replyTo: mailer.replyTo }),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "SEND_FAILED";
      const clean = `${code}: ${redactSecrets(raw, secrets)}`;
      if (run.attempt >= run.maxAttempts) {
        await recordOfferEmailFailure(deps.db, job.offerId, run.jobId, clean).catch(
          () => undefined,
        );
      }
      // eroare NOUĂ, curățată: stiva și mesajul originale pot conține adresa, jetonul sau corpul
      throw Object.assign(new Error(clean), { name: "EmailSendError" });
    }
    deps.logger.info({ jobId: run.jobId, kind, attempt: run.attempt }, "email ofertă trimis");
  };
}

export type OfferEmailDelivery = ReturnType<typeof createOfferEmailDelivery>;
