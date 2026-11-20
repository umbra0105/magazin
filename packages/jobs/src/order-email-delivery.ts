import { UnrecoverableError } from "bullmq";
import {
  claimDispatch,
  completeDispatch,
  failDispatch,
  redactSecrets,
  releaseDispatch,
  skipDispatch,
  type Db,
  type MailerConfig,
} from "@ecom/core";
import { renderTemplateEmail, type EmailTheme, type TemplateOverride } from "@ecom/emails";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import { buildOrderEmailContext, type StoreEmailSettings } from "./order-email-context";

/**
 * Trimiterea unui email de comandă din `EmailDispatch` (Faza 11). Ordinea: SMTP configurat → revendicare atomică (`queued →
 * sending`; doar un worker trimite) → context din baza de date → randare (cu suprascrierea din admin) → trimitere → `sent`.
 *
 *  - SMTP neconfigurat: rândul devine `failed` (vizibil în admin, retrimis după configurare), jobul nu se reîncearcă;
 *  - rând luat de altcineva sau deja trimis: nimic de făcut (a doua procesare a aceluiași eveniment nu trimite nimic);
 *  - destinatar sau comandă dispărute: `skipped`, cu motiv;
 *  - eșec la randare sau trimitere: rândul revine în coadă (`queued`) pentru reîncercarea BullMQ, cu eroarea curățată; la ULTIMA
 *    încercare devine `failed` (dead-letter, vizibil în admin);
 *  - în loguri intră doar `jobId`, șablonul și numărul încercării; niciodată adresa, linkul sau corpul.
 */
export interface OrderEmailDeliveryDeps {
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

export interface DeliveryAttempt {
  jobId: string;
  /** Numărul încercării curente (1, 2, …). */
  attempt: number;
  maxAttempts: number;
}

export function createOrderEmailDelivery(deps: OrderEmailDeliveryDeps) {
  return async function deliver(dispatchId: string, run: DeliveryAttempt): Promise<void> {
    const existing = await deps.db.emailDispatch.findUnique({ where: { id: dispatchId } });
    if (!existing || existing.status !== "queued") {
      deps.logger.info(
        { jobId: run.jobId, kind: "order-email", outcome: existing?.status ?? "missing" },
        "email comandă: nimic de trimis",
      );
      return;
    }
    let mailer: MailerConfig | null;
    try {
      mailer = await deps.loadMailer();
    } catch {
      mailer = null;
    }
    if (!mailer) {
      await failDispatch(
        deps.db,
        dispatchId,
        "SMTP neconfigurat sau inactiv: configurează-l și retrimite din admin",
      );
      deps.logger.warn(
        { jobId: run.jobId, kind: "order-email" },
        "email comandă: SMTP neconfigurat, renunț",
      );
      throw new UnrecoverableError("EMAIL_NOT_CONFIGURED");
    }
    const row = await claimDispatch(deps.db, dispatchId, deps.now());
    if (!row) {
      deps.logger.info(
        { jobId: run.jobId, kind: "order-email" },
        "email comandă: luat de alt worker",
      );
      return;
    }
    const secrets: string[] = [row.recipient];
    try {
      const store = await deps.loadStore();
      const built = await buildOrderEmailContext(
        { db: deps.db, appUrl: deps.appUrl, now: deps.now, store },
        row,
      );
      if (built.kind === "skip") {
        await skipDispatch(deps.db, dispatchId, built.reason);
        deps.logger.info(
          { jobId: run.jobId, kind: "order-email", template: row.template, outcome: "skipped" },
          "email comandă: omis",
        );
        return;
      }
      for (const value of Object.values(built.context.vars)) if (value) secrets.push(value);
      const [theme, override] = await Promise.all([
        deps.loadTheme(),
        deps.loadOverride(row.template),
      ]);
      const rendered = await renderTemplateEmail(theme, row.template, built.context, { override });
      secrets.push(rendered.html, rendered.text);
      await deps.sendMail(mailer, {
        from: { name: mailer.fromName, address: mailer.fromAddress },
        to: built.to,
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
      if (run.attempt >= run.maxAttempts) await failDispatch(deps.db, dispatchId, clean);
      else await releaseDispatch(deps.db, dispatchId, clean);
      // aruncăm o eroare NOUĂ, curățată: stiva și mesajul originale pot conține adresa sau corpul
      throw Object.assign(new Error(clean), { name: "EmailSendError" });
    }
    try {
      await completeDispatch(deps.db, dispatchId, deps.now());
    } catch {
      // trimis, dar neînregistrat: NU se aruncă (o reîncercare ar trimite emailul a doua oară); rămâne «sending» și
      // măturătorul îl marchează «failed» pentru verificare, fără retrimitere automată
      deps.logger.warn(
        { jobId: run.jobId, kind: "order-email" },
        "email trimis, dar starea nu s-a putut scrie",
      );
    }
    deps.logger.info(
      { jobId: run.jobId, kind: "order-email", template: row.template, attempt: run.attempt },
      "email comandă trimis",
    );
  };
}

export type OrderEmailDelivery = ReturnType<typeof createOrderEmailDelivery>;
