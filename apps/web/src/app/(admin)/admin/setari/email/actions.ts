"use server";

import { z } from "zod";
import { SMTP_INTEGRATION, loadMailerConfig, type SettingKey } from "@ecom/core";
import {
  renderTemplateEmail,
  sampleContext,
  sendViaSmtp,
  templateDefinition,
  verifySmtp,
} from "@ecom/jobs";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { currentTheme, getIntegrations } from "@/lib/email-admin";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Serverul SMTP al magazinului (Faza 11), doar pentru `email.configure` (Owner, ca la cheile de integrare). Parola se salvează
 * criptată (`APP_KEY`), nu se mai afișează după salvare (doar «Salvat»), nu apare în audit (doar numele câmpului schimbat) și nu
 * iese din server. Testul conexiunii și emailul de test pleacă direct din server, în afara oricărei tranzacții, și întorc doar
 * reușit sau eșuat (fără mesajul serverului SMTP, care ar putea conține adrese sau date).
 */
const EMAIL = z.string().trim().toLowerCase().email().max(254);

const saveInput = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(254),
  /** Gol = păstrează parola salvată. */
  password: z.string().max(500),
  clearPassword: z.boolean(),
  isActive: z.boolean(),
  fromName: z.string().trim().max(120),
  fromAddress: z.string().trim().max(254),
  replyTo: z.string().trim().max(254),
  internalRecipients: z.string().max(5000),
});

type SmtpField = "host" | "port" | "fromAddress" | "replyTo" | "internalRecipients" | "form";
export type SaveSmtpResult =
  { ok: true } | { ok: false; errors: Partial<Record<SmtpField, string>> };

export const saveSmtpAction = withPermission(
  "email.configure",
  async (raw: unknown, subject): Promise<SaveSmtpResult> => {
    const parsed = saveInput.safeParse(raw);
    if (!parsed.success) {
      const errors: Partial<Record<SmtpField, string>> = { form: "invalid" };
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (field === "host" || field === "port") errors[field] = "invalid";
      }
      return { ok: false, errors };
    }
    const d = parsed.data;
    const errors: Partial<Record<SmtpField, string>> = {};
    if (d.fromAddress !== "" && !EMAIL.safeParse(d.fromAddress).success)
      errors.fromAddress = "invalid";
    if (d.replyTo !== "" && !EMAIL.safeParse(d.replyTo).success) errors.replyTo = "invalid";
    const recipients = [
      ...new Set(
        d.internalRecipients
          .split(/[\n,;]+/)
          .map((line) => line.trim().toLowerCase())
          .filter((line) => line !== ""),
      ),
    ];
    if (
      recipients.length > 20 ||
      !recipients.every((address) => EMAIL.safeParse(address).success)
    ) {
      errors.internalRecipients = "invalid";
    }
    if (d.isActive && d.fromAddress === "") errors.fromAddress = "invalid";
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const actor = { id: subject.userId, label: subject.email };
    const writes = getAdminWrites();
    await writes.saveIntegration(
      {
        type: SMTP_INTEGRATION.type,
        provider: SMTP_INTEGRATION.provider,
        config: {
          host: d.host,
          port: d.port,
          secure: d.secure,
          ...(d.user !== "" ? { user: d.user } : {}),
        },
        isActive: d.isActive,
        // parola nouă înlocuiește; «șterge» o golește; altfel rămâne cea salvată
        ...(d.password !== ""
          ? { credentials: { password: d.password } }
          : d.clearPassword
            ? { credentials: {} }
            : {}),
      },
      actor,
    );
    const settings = getSettings();
    const next: Array<[SettingKey, unknown]> = [
      ["email.fromName", d.fromName],
      ["email.fromAddress", d.fromAddress.toLowerCase()],
      ["email.replyTo", d.replyTo.toLowerCase()],
      ["email.internalRecipients", recipients],
    ];
    for (const [key, value] of next) {
      if (JSON.stringify(await settings.get(key)) === JSON.stringify(value)) continue;
      await writes.updateSetting({ key, value }, actor);
    }
    return { ok: true };
  },
  { action: "email.smtp.save", entity: "integration" },
);

/**
 * Configurația de trimitere pentru teste: ca cea reală, dar și cu integrarea încă inactivă (testul se face ÎNAINTE de activare).
 * Parola decriptată rămâne în memoria serverului; nimic nu iese spre interfață.
 */
async function mailerForTest() {
  try {
    const integrations = getIntegrations();
    return await loadMailerConfig({
      integrations: Object.assign(Object.create(integrations) as typeof integrations, {
        getPublicView: async (type: string, provider: string) => {
          const view = await integrations.getPublicView(type, provider);
          return view ? { ...view, isActive: true } : null;
        },
      }),
      settings: getSettings(),
    });
  } catch {
    return null;
  }
}

export type SmtpTestResult = { ok: true } | { ok: false; code: "notConfigured" | "failed" };

export const testSmtpConnectionAction = withPermission(
  "email.configure",
  async (_raw: unknown, subject): Promise<SmtpTestResult> => {
    const mailer = await mailerForTest();
    if (!mailer) return { ok: false, code: "notConfigured" };
    try {
      await verifySmtp(mailer);
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "email.smtp.test-connection",
        entity: "integration",
        entityId: "smtp",
        after: { ok: true },
      });
      return { ok: true };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.smtp.test-connection", entity: "integration" },
);

export type SmtpEmailResult =
  { ok: true; to: string } | { ok: false; code: "email" | "notConfigured" | "failed" };

export const sendSmtpTestEmailAction = withPermission(
  "email.configure",
  async (raw: unknown, subject): Promise<SmtpEmailResult> => {
    const parsed = z.strictObject({ to: z.string().max(254) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const to = parsed.data.to.trim().toLowerCase();
    if (!EMAIL.safeParse(to).success) return { ok: false, code: "email" };
    const mailer = await mailerForTest();
    const definition = templateDefinition("order.processing");
    if (!mailer || !definition) return { ok: false, code: "notConfigured" };
    try {
      const rendered = await renderTemplateEmail(
        await currentTheme(),
        definition.key,
        sampleContext(definition),
        { sample: true, testSend: true },
      );
      await sendViaSmtp(mailer, {
        from: { name: mailer.fromName, address: mailer.fromAddress },
        to,
        ...(mailer.replyTo && { replyTo: mailer.replyTo }),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "email.smtp.test-email",
        entity: "integration",
        entityId: "smtp",
        after: { sent: true },
      });
      return { ok: true, to };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.smtp.test-email", entity: "integration" },
);
