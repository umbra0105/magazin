"use server";

import { z } from "zod";
import { getDb } from "@ecom/db";
import { EFACTURA_STATUSES } from "@ecom/shared";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { getInvoiceService } from "@/lib/invoicing";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului asupra documentelor fiscale (Faza 13): «Reîncearcă», «Emite factura acum», «Stornează factura», starea
 * e-Factura. Fiecare cere `invoices.write` (verificată din nou pe server), validează intrarea cu Zod, apelează `InvoiceService`
 * (care scrie jurnalul documentului și `OrderEvent`) și scrie auditul: actorul, acțiunea și documentul, NICIODATĂ datele clientului.
 * Emiterea propriu-zisă o face workerul (prin coadă); aici documentul doar se pune în coadă sau se repune în coadă.
 */
type Fail = { ok: false; code: string };
export type InvoiceActionResult = { ok: true } | Fail;

const id = z.string().min(1).max(64);
const PREFIXES = ["INVOICE_"] as const;

function failure(error: unknown): Fail {
  return { ok: false, code: errorCodeOf(error, PREFIXES) ?? "failed" };
}

const record = (
  subject: { userId: string; email: string },
  action: string,
  orderId: string,
  after: Record<string, unknown>,
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "order",
    entityId: orderId,
    after,
  });

const retryForm = z.strictObject({ invoiceId: id, confirmNotIssued: z.boolean().default(false) });

export const retryInvoiceAction = withPermission(
  "invoices.write",
  async (raw: unknown, subject): Promise<InvoiceActionResult> => {
    const parsed = retryForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      const service = getInvoiceService();
      await service.retry(parsed.data.invoiceId, subject.email, parsed.data.confirmNotIssued);
      const doc = await getDb().invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { orderId: true, kind: true, docKey: true },
      });
      if (doc) {
        await record(subject, "invoice.retry", doc.orderId, {
          kind: doc.kind,
          docKey: doc.docKey,
          confirmedNotIssued: parsed.data.confirmNotIssued,
        });
      }
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "invoice.retry", entity: "order" },
);

const orderForm = z.strictObject({ orderId: id });

export const issueInvoiceAction = withPermission(
  "invoices.write",
  async (raw: unknown, subject): Promise<InvoiceActionResult> => {
    const parsed = orderForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await getInvoiceService().requestInvoice(parsed.data.orderId, subject.email);
      await record(subject, "invoice.request", parsed.data.orderId, { kind: "invoice" });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "invoice.request", entity: "order" },
);

export const reverseInvoiceAction = withPermission(
  "invoices.write",
  async (raw: unknown, subject): Promise<InvoiceActionResult> => {
    const parsed = orderForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await getInvoiceService().requestReverse(parsed.data.orderId, subject.email);
      await record(subject, "invoice.reverse", parsed.data.orderId, { kind: "storno" });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "invoice.reverse", entity: "order" },
);

const efacturaForm = z.strictObject({
  invoiceId: id,
  orderId: id,
  status: z.enum(EFACTURA_STATUSES),
});

export const setEfacturaStatusAction = withPermission(
  "invoices.write",
  async (raw: unknown, subject): Promise<InvoiceActionResult> => {
    const parsed = efacturaForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await getInvoiceService().setEfacturaStatus(
        parsed.data.invoiceId,
        parsed.data.status,
        subject.email,
      );
      await record(subject, "invoice.efactura", parsed.data.orderId, {
        invoiceId: parsed.data.invoiceId,
        status: parsed.data.status,
      });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "invoice.efactura", entity: "order" },
);
