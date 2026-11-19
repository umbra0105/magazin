"use server";

import { z } from "zod";
import { PaymentError, confirmManualRefund, requestRefund } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { parseMoneyInput } from "@/lib/money-input";
import { getPaymentConfig } from "@/lib/payments";
import { withPermission } from "@/lib/session";

/**
 * Rambursările din admin: `/admin/plati`. Cer `payments.refund`. Suma, plafonul (≤ încasat − deja angajat, sub blocare) și
 * idempotența (cheia vine din formular: dublu-click = o singură rambursare) sunt verificate pe server, în `requestRefund`.
 * Rambursarea face DOAR banii: nu atinge stocul și nu înregistrează un retur. Fiecare acțiune intră în jurnalul de audit, cu
 * actorul, suma și motivul; niciodată date de card sau chei.
 */
const refundForm = z.strictObject({
  paymentId: z.string().min(1).max(64),
  amount: z.string().max(40),
  reason: z.string().max(500),
  requestKey: z.string().min(8).max(80),
});

export type RefundActionResult =
  { ok: true } | { ok: false; code: "amount" | "tooHigh" | "reason" | "notRefundable" | "failed" };

const providerAccess = () => ({
  db: getDb(),
  getProvider: (code: string) => getPaymentConfig().getProvider(code),
  now: () => new Date(),
});

export const refundPayment = withPermission(
  "payments.refund",
  async (raw: unknown, subject): Promise<RefundActionResult> => {
    const parsed = refundForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const minor = parseMoneyInput(parsed.data.amount);
    if (minor === null || minor < 1) return { ok: false, code: "amount" };
    const reason = parsed.data.reason.trim();
    if (reason === "") return { ok: false, code: "reason" };
    try {
      const result = await requestRefund(providerAccess(), {
        paymentId: parsed.data.paymentId,
        amountMinor: minor,
        reason,
        idempotencyKey: `admin:${parsed.data.paymentId}:${parsed.data.requestKey}`,
        actorLabel: subject.email,
      });
      if (result.created) {
        await getAudit().record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "payment.refund.request",
          entity: "payment",
          entityId: parsed.data.paymentId,
          after: { refundId: result.refundId, amountMinor: minor, reason },
        });
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof PaymentError) {
        if (error.code === "REFUND_EXCEEDS_PAID") return { ok: false, code: "tooHigh" };
        if (error.code === "PAYMENT_NOT_REFUNDABLE") return { ok: false, code: "notRefundable" };
        if (error.code === "REFUND_INVALID") return { ok: false, code: "amount" };
      }
      return { ok: false, code: "failed" };
    }
  },
  { action: "payment.refund.request", entity: "payment" },
);

const manualForm = z.strictObject({
  refundId: z.string().min(1).max(64),
  reference: z.string().max(200),
});

export type ManualRefundResult = { ok: true } | { ok: false; code: "reference" | "failed" };

export const markRefundDoneManually = withPermission(
  "payments.refund",
  async (raw: unknown, subject): Promise<ManualRefundResult> => {
    const parsed = manualForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    const reference = parsed.data.reference.trim();
    if (reference === "") return { ok: false, code: "reference" };
    try {
      const refund = await confirmManualRefund(providerAccess(), {
        refundId: parsed.data.refundId,
        reference,
        actorLabel: subject.email,
      });
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "payment.refund.manual-confirm",
        entity: "refund",
        entityId: refund.id,
        after: { paymentId: refund.paymentId, amountMinor: refund.amountMinor, reference },
      });
      return { ok: true };
    } catch {
      return { ok: false, code: "failed" };
    }
  },
  { action: "payment.refund.manual-confirm", entity: "refund" },
);
