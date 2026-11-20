"use server";

import { z } from "zod";
import {
  addOrderNote,
  cancelOrder,
  can,
  clearSupplierMark,
  correctOrderAddress,
  correctOrderContact,
  isInstallationStatus,
  markAtSupplier,
  markBankTransferPaid,
  requestOrderRefund,
  resendDispatch,
  setInstallationStatus,
  startProcessing,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { parseMoneyInput } from "@/lib/money-input";
import { getPaymentConfig } from "@/lib/payments";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului pe o comandă (Faza 11). Fiecare cere permisiunea ei (verificată din nou pe server, la fiecare apel), validează
 * intrarea cu Zod, apelează serviciul din `packages/core` (care scrie `OrderEvent` în aceeași tranzacție) și scrie auditul: actorul,
 * acțiunea și ce s-a schimbat, NICIODATĂ textul notelor, adresele sau datele de contact. Rezultatul e un cod stabil, tradus în
 * mesaj de interfață. Acțiunile nu rulează nimic în afara tranzacției decât rambursarea (apelul la procesator, ca în Faza 10).
 */
type Fail<C extends string> = { ok: false; code: C | "failed" | "invalid" };

const id = z.string().min(1).max(64);

function failure<C extends string>(error: unknown, known: Record<string, C>): Fail<C> {
  const code = errorCodeOf(error, ["ORDER_", "PAYMENT_", "REFUND_"]);
  const mapped = code ? known[code] : undefined;
  return { ok: false, code: mapped ?? "failed" };
}

const auditOrder = (
  subject: { userId: string; email: string },
  action: string,
  orderId: string,
  after: Record<string, unknown> = {},
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "order",
    entityId: orderId,
    after,
  });

// --- începe pregătirea -------------------------------------------------------------------------------------------------

export type ProcessResult = { ok: true; already: boolean } | Fail<"notConfirmed">;

export const processOrder = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<ProcessResult> => {
    const parsed = z.strictObject({ orderId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await startProcessing(getDb(), parsed.data.orderId, {
        actorLabel: subject.email,
        now: new Date(),
      });
      if (!result.alreadyProcessing)
        await auditOrder(subject, "order.processing", parsed.data.orderId);
      return { ok: true, already: result.alreadyProcessing };
    } catch (error) {
      return failure(error, { ORDER_PROCESSING_INVALID: "notConfirmed" });
    }
  },
  { action: "order.processing", entity: "order" },
);

// --- anulare ----------------------------------------------------------------------------------------------------------

export type CancelResult =
  { ok: true; needsRefund: boolean } | Fail<"reason" | "paidDecision" | "cannotCancel">;

export const cancelOrderAction = withPermission(
  "orders.cancel",
  async (raw: unknown, subject): Promise<CancelResult> => {
    const parsed = z
      .strictObject({ orderId: id, reason: z.string().max(500), acknowledgePaid: z.boolean() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await cancelOrder(getDb(), parsed.data.orderId, {
        reason: parsed.data.reason,
        acknowledgePaid: parsed.data.acknowledgePaid,
        actorLabel: subject.email,
        now: new Date(),
      });
      if (!result.alreadyCancelled) {
        await auditOrder(subject, "order.cancel", parsed.data.orderId, {
          needsRefund: result.needsRefund,
          acknowledgedPaid: parsed.data.acknowledgePaid,
        });
      }
      return { ok: true, needsRefund: result.needsRefund };
    } catch (error) {
      return failure(error, {
        ORDER_CANCEL_PAID_NEEDS_DECISION: "paidDecision",
        ORDER_CANCEL_INVALID: parsed.data.reason.trim().length < 3 ? "reason" : "cannotCancel",
      });
    }
  },
  { action: "order.cancel", entity: "order" },
);

// --- rambursare din comandă (cu limita rolului Suport) ------------------------------------------------------------------

export type OrderRefundResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "amount"
        | "tooHigh"
        | "reason"
        | "notRefundable"
        | "overLimit"
        | "limitUnavailable"
        | "failed"
        | "invalid";
      remainingMinor?: number;
    };

export const refundOrderAction = withPermission(
  "orders.refund",
  async (raw: unknown, subject): Promise<OrderRefundResult> => {
    const parsed = z
      .strictObject({
        orderId: id,
        amount: z.string().max(40),
        reason: z.string().max(500),
        requestKey: z.string().min(8).max(80),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const minor = parseMoneyInput(parsed.data.amount);
    if (minor === null || minor < 1) return { ok: false, code: "amount" };
    const reason = parsed.data.reason.trim();
    if (reason === "") return { ok: false, code: "reason" };
    try {
      const result = await requestOrderRefund(
        {
          db: getDb(),
          getProvider: (code: string) => getPaymentConfig().getProvider(code),
          now: () => new Date(),
          // setarea se citește FĂRĂ cache (o limită coborâtă se aplică imediat); o eroare la citire = refuz, nu «fără limită»
          readLimitMinor: async () =>
            (await getSettings().getGroupUncached("payment")).supportRefundLimit,
        },
        {
          orderId: parsed.data.orderId,
          amountMinor: minor,
          reason,
          idempotencyKey: `order:${parsed.data.orderId}:${parsed.data.requestKey}`,
          actorLabel: subject.email,
          // fără `payments.refund` (rolul Suport) rambursarea e CU LIMITĂ, aplicată pe server sub blocarea comenzii
          actorUnlimited: can(subject, "payments.refund"),
        },
      );
      if (result.created) {
        await auditOrder(subject, "order.refund.request", parsed.data.orderId, {
          refundId: result.refundId,
          amountMinor: minor,
          reason,
          limited: !can(subject, "payments.refund"),
        });
      }
      return { ok: true };
    } catch (error) {
      const code = errorCodeOf(error, ["REFUND_", "PAYMENT_", "ORDER_"]);
      if (code === "REFUND_OVER_LIMIT") {
        const details = (error as { details?: { remainingMinor?: unknown } }).details;
        return {
          ok: false,
          code: "overLimit",
          remainingMinor: typeof details?.remainingMinor === "number" ? details.remainingMinor : 0,
        };
      }
      if (code === "REFUND_LIMIT_UNAVAILABLE") return { ok: false, code: "limitUnavailable" };
      if (code === "REFUND_EXCEEDS_PAID") return { ok: false, code: "tooHigh" };
      if (code === "PAYMENT_NOT_REFUNDABLE" || code === "PAYMENT_NOT_FOUND") {
        return { ok: false, code: "notRefundable" };
      }
      if (code === "REFUND_INVALID") return { ok: false, code: "amount" };
      return { ok: false, code: "failed" };
    }
  },
  { action: "order.refund.request", entity: "order" },
);

// --- marchează plătit (transfer bancar) ---------------------------------------------------------------------------------

export type MarkPaidResult =
  | { ok: true; already: boolean; differenceMinor: number }
  | {
      ok: false;
      code: "amount" | "reference" | "mismatch" | "notPending" | "failed" | "invalid";
      expectedMinor?: number;
    };

export const markPaidAction = withPermission(
  "orders.mark_paid",
  async (raw: unknown, subject): Promise<MarkPaidResult> => {
    const parsed = z
      .strictObject({
        orderId: id,
        amount: z.string().max(40),
        reference: z.string().max(200),
        acceptDifference: z.boolean(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const minor = parseMoneyInput(parsed.data.amount);
    if (minor === null || minor < 1) return { ok: false, code: "amount" };
    try {
      const result = await markBankTransferPaid(getDb(), parsed.data.orderId, {
        amountMinor: minor,
        reference: parsed.data.reference,
        acceptDifference: parsed.data.acceptDifference,
        actorLabel: subject.email,
        now: new Date(),
      });
      if (!result.alreadyPaid) {
        await auditOrder(subject, "order.mark-paid", parsed.data.orderId, {
          receivedMinor: minor,
          differenceMinor: result.differenceMinor,
          acceptedDifference: parsed.data.acceptDifference,
        });
      }
      return { ok: true, already: result.alreadyPaid, differenceMinor: result.differenceMinor };
    } catch (error) {
      const code = errorCodeOf(error, ["ORDER_"]);
      if (code === "ORDER_PAYMENT_AMOUNT_MISMATCH") {
        const details = (error as { details?: { expectedMinor?: unknown } }).details;
        return {
          ok: false,
          code: "mismatch",
          ...(typeof details?.expectedMinor === "number"
            ? { expectedMinor: details.expectedMinor }
            : {}),
        };
      }
      if (code === "ORDER_PAYMENT_REFERENCE_INVALID") return { ok: false, code: "reference" };
      if (code === "ORDER_PAYMENT_AMOUNT_INVALID") return { ok: false, code: "amount" };
      if (code === "ORDER_PAYMENT_NOT_PENDING") return { ok: false, code: "notPending" };
      return { ok: false, code: "failed" };
    }
  },
  { action: "order.mark-paid", entity: "order" },
);

// --- marcajul «La furnizor» ---------------------------------------------------------------------------------------------

export type SupplierResult = { ok: true; changed: boolean } | Fail<"markInvalid">;

export const markSupplierAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<SupplierResult> => {
    const parsed = z
      .strictObject({ orderId: id, name: z.string().max(400), note: z.string().max(2000) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await markAtSupplier(getDb(), parsed.data.orderId, {
        supplierName: parsed.data.name,
        note: parsed.data.note,
        actorLabel: subject.email,
        now: new Date(),
      });
      if (result.changed) {
        await auditOrder(subject, "order.supplier.mark", parsed.data.orderId, {
          hasName: parsed.data.name.trim() !== "",
          hasNote: parsed.data.note.trim() !== "",
        });
      }
      return { ok: true, changed: result.changed };
    } catch (error) {
      return failure(error, { ORDER_SUPPLIER_MARK_INVALID: "markInvalid" });
    }
  },
  { action: "order.supplier.mark", entity: "order" },
);

export const clearSupplierAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<SupplierResult> => {
    const parsed = z.strictObject({ orderId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await clearSupplierMark(getDb(), parsed.data.orderId, {
        actorLabel: subject.email,
        now: new Date(),
      });
      if (result.changed) await auditOrder(subject, "order.supplier.clear", parsed.data.orderId);
      return { ok: true, changed: result.changed };
    } catch (error) {
      return failure(error, {});
    }
  },
  { action: "order.supplier.clear", entity: "order" },
);

// --- note interne -------------------------------------------------------------------------------------------------------

export type NoteResult = { ok: true } | Fail<"noteInvalid">;

export const addNoteAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<NoteResult> => {
    const parsed = z.strictObject({ orderId: id, body: z.string().max(5000) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const note = await addOrderNote(getDb(), parsed.data.orderId, {
        body: parsed.data.body,
        authorLabel: subject.email,
      });
      // în audit intră doar id-ul notei, niciodată textul (poate conține date personale)
      await auditOrder(subject, "order.note.add", parsed.data.orderId, { noteId: note.id });
      return { ok: true };
    } catch (error) {
      return failure(error, { ORDER_NOTE_INVALID: "noteInvalid" });
    }
  },
  { action: "order.note.add", entity: "order" },
);

// --- corectarea contactului și a adresei -----------------------------------------------------------------------------------

export type EditResult = { ok: true; changed: string[] } | Fail<"editInvalid">;

export const correctOrderAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<EditResult> => {
    const parsed = z
      .strictObject({
        orderId: id,
        email: z.string().max(300),
        phone: z.string().max(60),
        shipping: z.strictObject({
          fullName: z.string().max(300),
          phone: z.string().max(60),
          street: z.string().max(400),
          postalCode: z.string().max(20),
        }),
        billing: z
          .strictObject({
            fullName: z.string().max(300),
            phone: z.string().max(60),
            street: z.string().max(400),
            postalCode: z.string().max(20),
          })
          .nullable(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const db = getDb();
    const changed: string[] = [];
    try {
      const contact = await correctOrderContact(db, parsed.data.orderId, {
        email: parsed.data.email,
        phone: parsed.data.phone,
        actorLabel: subject.email,
      });
      changed.push(...contact.changed.map((field) => `contact.${field}`));
      const shipping = await correctOrderAddress(
        db,
        parsed.data.orderId,
        "shipping",
        parsed.data.shipping,
        subject.email,
      );
      changed.push(...shipping.changed.map((field) => `shipping.${field}`));
      if (parsed.data.billing) {
        const billing = await correctOrderAddress(
          db,
          parsed.data.orderId,
          "billing",
          parsed.data.billing,
          subject.email,
        );
        changed.push(...billing.changed.map((field) => `billing.${field}`));
      }
      // în audit intră doar CÂMPURILE schimbate, nu valorile (date personale)
      if (changed.length > 0)
        await auditOrder(subject, "order.correct", parsed.data.orderId, { fields: changed });
      return { ok: true, changed };
    } catch (error) {
      return failure(error, { ORDER_EDIT_INVALID: "editInvalid" });
    }
  },
  { action: "order.correct", entity: "order" },
);

// --- retrimite un email --------------------------------------------------------------------------------------------------

export type ResendResult = { ok: true } | Fail<"inFlight">;

export const resendOrderEmailAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<ResendResult> => {
    const parsed = z.strictObject({ orderId: id, dispatchId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      // doar un email AL ACESTEI comenzi: id-ul unui rând al altei comenzi nu se retrimite de aici
      const row = await getDb().emailDispatch.findFirst({
        where: { id: parsed.data.dispatchId, orderId: parsed.data.orderId },
        select: { id: true, template: true },
      });
      if (!row) return { ok: false, code: "invalid" };
      const result = await resendDispatch(getDb(), row.id, { actorLabel: subject.email });
      if (!result) return { ok: false, code: "inFlight" };
      await auditOrder(subject, "order.email.resend", parsed.data.orderId, {
        template: row.template,
        dispatchId: result.newId,
      });
      return { ok: true };
    } catch (error) {
      return failure(error, {});
    }
  },
  { action: "order.email.resend", entity: "order" },
);

// --- cererea de instalare ------------------------------------------------------------------------------------------------

export type InstallationResult = { ok: true; changed: boolean } | Fail<"installInvalid">;

export const setInstallationStatusAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<InstallationResult> => {
    const parsed = z.strictObject({ orderId: id, status: z.string().max(30) }).safeParse(raw);
    if (!parsed.success || !isInstallationStatus(parsed.data.status)) {
      return { ok: false, code: "invalid" };
    }
    try {
      const result = await setInstallationStatus(getDb(), parsed.data.orderId, parsed.data.status, {
        actorLabel: subject.email,
        now: new Date(),
      });
      if (result.changed) {
        await auditOrder(subject, "order.installation.status", parsed.data.orderId, {
          status: parsed.data.status,
        });
      }
      return { ok: true, changed: result.changed };
    } catch (error) {
      return failure(error, { ORDER_INSTALLATION_INVALID: "installInvalid" });
    }
  },
  { action: "order.installation.status", entity: "order" },
);
