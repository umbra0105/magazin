"use server";

import { z } from "zod";
import {
  deleteEmailOverride,
  getEmailOverride,
  resendDispatch,
  saveEmailOverride,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  renderTemplateEmail,
  sampleContext,
  sendViaSmtp,
  templateDefinition,
  validateOverride,
} from "@ecom/jobs";
import { getAudit } from "@/lib/admin-writes";
import { currentMailer, currentTheme } from "@/lib/email-admin";
import { withPermission } from "@/lib/session";

/**
 * Șabloanele de email din admin (Faza 11): suprascrierea subiectului și a textului de început, revenirea la implicit, emailul de
 * test și retrimiterea din jurnal. Cer `email.write` (verificat din nou pe server). Suprascrierea se validează aici cu aceleași
 * reguli ca la randare (doar variabilele șablonului, lungimi, fără acolade nepereche); auditul păstrează doar numele șablonului,
 * niciodată textul. Emailul de test pleacă direct prin SMTP (nu e într-o tranzacție) cu date de probă și «[TEST]» în subiect.
 */
const key = z.string().min(1).max(80);

export type OverrideResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid" | "unknown" | "failed";
      problems?: Array<{ code: string; names?: string[] }>;
    };

export const saveOverrideAction = withPermission(
  "email.write",
  async (raw: unknown, subject): Promise<OverrideResult> => {
    const parsed = z
      .strictObject({ template: key, subject: z.string().max(1000), intro: z.string().max(5000) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const definition = templateDefinition(parsed.data.template);
    if (!definition) return { ok: false, code: "unknown" };
    const problems = validateOverride(
      { subject: parsed.data.subject, intro: parsed.data.intro },
      definition.variables.map((variable) => variable.name),
    );
    if (problems.length > 0) {
      return {
        ok: false,
        code: "invalid",
        problems: problems.map((problem) =>
          problem.code === "unknown_variable"
            ? { code: problem.code, names: problem.names }
            : { code: problem.code },
        ),
      };
    }
    try {
      await saveEmailOverride(getDb(), {
        template: definition.key,
        subject: parsed.data.subject,
        intro: parsed.data.intro,
        updatedBy: subject.email,
      });
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "email.template.override",
        entity: "email_template",
        entityId: definition.key,
        after: { changed: true },
      });
      return { ok: true };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.template.override", entity: "email_template" },
);

export const resetOverrideAction = withPermission(
  "email.write",
  async (raw: unknown, subject): Promise<OverrideResult> => {
    const parsed = z.strictObject({ template: key }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const definition = templateDefinition(parsed.data.template);
    if (!definition) return { ok: false, code: "unknown" };
    try {
      const removed = await deleteEmailOverride(getDb(), definition.key);
      if (removed) {
        await getAudit().record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "email.template.reset",
          entity: "email_template",
          entityId: definition.key,
          after: { reset: true },
        });
      }
      return { ok: true };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.template.reset", entity: "email_template" },
);

export type TestSendResult =
  { ok: true; to: string } | { ok: false; code: "email" | "noSmtp" | "unknown" | "failed" };

export const sendTestAction = withPermission(
  "email.write",
  async (raw: unknown, subject): Promise<TestSendResult> => {
    const parsed = z.strictObject({ template: key, to: z.string().max(254) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const to = parsed.data.to.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, code: "email" };
    const definition = templateDefinition(parsed.data.template);
    if (!definition) return { ok: false, code: "unknown" };
    const mailer = await currentMailer();
    if (!mailer) return { ok: false, code: "noSmtp" };
    try {
      const override = await getEmailOverride(getDb(), definition.key);
      const rendered = await renderTemplateEmail(
        await currentTheme(),
        definition.key,
        sampleContext(definition),
        {
          override: override ? { subject: override.subject, intro: override.intro } : null,
          sample: true,
          testSend: true,
        },
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
        action: "email.template.test",
        entity: "email_template",
        entityId: definition.key,
        after: { sent: true },
      });
      return { ok: true, to };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.template.test", entity: "email_template" },
);

export type LogResendResult = { ok: true } | { ok: false; code: "inFlight" | "failed" };

export const resendLogAction = withPermission(
  "email.write",
  async (raw: unknown, subject): Promise<LogResendResult> => {
    const parsed = z.strictObject({ dispatchId: key }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      const row = await getDb().emailDispatch.findUnique({
        where: { id: parsed.data.dispatchId },
        select: { template: true, orderId: true },
      });
      if (!row) return { ok: false, code: "failed" };
      const result = await resendDispatch(getDb(), parsed.data.dispatchId, {
        actorLabel: subject.email,
      });
      if (!result) return { ok: false, code: "inFlight" };
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "email.resend",
        entity: row.orderId ? "order" : "email_dispatch",
        entityId: row.orderId ?? parsed.data.dispatchId,
        after: { template: row.template, dispatchId: result.newId },
      });
      return { ok: true };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "email.resend", entity: "email_dispatch" },
);
