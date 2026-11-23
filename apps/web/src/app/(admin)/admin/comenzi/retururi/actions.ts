"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  approveReturn,
  can,
  inspectReturn,
  markAwaitingShipment,
  markReturnReceived,
  refundReturn,
  rejectReturn,
  restockReturn,
  setReturnAdminNote,
  setReturnAwb,
  type RestockResult,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { parseMoneyInput } from "@/lib/money-input";
import { getPaymentConfig } from "@/lib/payments";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului pe un retur (Faza 14). Fiecare cere `returns.manage` (verificată din nou pe server), validează intrarea cu Zod,
 * apelează serviciul din `packages/core` (state machine, jurnal, emailuri prin outbox) și scrie auditul: actorul, acțiunea, returul și
 * sumele, NICIODATĂ textul notelor, motivul scris pentru client, adresele sau datele de contact. Rambursarea cere ȘI `orders.refund`
 * și trece prin serviciul din Faza 10 (aceeași limită pentru Suport, aceeași idempotență).
 */
type Fail = { ok: false; code: string };
export type ReturnActionResult<T = object> = ({ ok: true } & T) | Fail;

const id = z.string().min(1).max(64);
const PREFIXES = ["RETURN_", "REFUND_", "PAYMENT_", "STOCK_"] as const;

const failure = (error: unknown): Fail => ({
  ok: false,
  code: errorCodeOf(error, PREFIXES) ?? "failed",
});

const record = (
  subject: { userId: string; email: string },
  action: string,
  returnId: string,
  after: Record<string, unknown> = {},
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "return",
    entityId: returnId,
    after,
  });

const done = (returnId: string): void => {
  revalidatePath("/admin/comenzi/retururi");
  revalidatePath(`/admin/comenzi/retururi/${returnId}`);
};

const base = z.strictObject({ returnId: id });

export const approveReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base.extend({ note: z.string().max(1000).optional() }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await approveReturn(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        new Date(),
        parsed.data.note,
      );
      await record(subject, "return.approve", parsed.data.returnId, {
        hasNote: Boolean(parsed.data.note),
      });
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.approve", entity: "return" },
);

export const rejectReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base.extend({ reason: z.string().max(500) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await rejectReturn(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        parsed.data.reason,
        new Date(),
      );
      await record(subject, "return.reject", parsed.data.returnId);
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.reject", entity: "return" },
);

export const setReturnAwbAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base
      .extend({
        carrier: z.string().max(120),
        awb: z.string().max(120),
        trackingUrl: z.string().max(400).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await setReturnAwb(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        {
          carrier: parsed.data.carrier,
          awb: parsed.data.awb,
          ...(parsed.data.trackingUrl ? { trackingUrl: parsed.data.trackingUrl } : {}),
        },
        new Date(),
      );
      await record(subject, "return.awb", parsed.data.returnId, { awb: parsed.data.awb.trim() });
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.awb", entity: "return" },
);

export const awaitShipmentAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await markAwaitingShipment(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        new Date(),
      );
      await record(subject, "return.await_shipment", parsed.data.returnId);
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.await_shipment", entity: "return" },
);

export const receiveReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await markReturnReceived(getDb(), parsed.data.returnId, { label: subject.email }, new Date());
      await record(subject, "return.receive", parsed.data.returnId);
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.receive", entity: "return" },
);

export const inspectReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base
      .extend({
        note: z.string().max(1000).optional(),
        lines: z
          .array(
            z.strictObject({
              returnItemId: id,
              acceptedQuantity: z.string().max(40),
              condition: z.string().max(40),
              resellable: z.boolean(),
            }),
          )
          .min(1)
          .max(200),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await inspectReturn(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        parsed.data.lines,
        new Date(),
        parsed.data.note,
      );
      await record(subject, "return.inspect", parsed.data.returnId, {
        lines: parsed.data.lines.length,
      });
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.inspect", entity: "return" },
);

export const noteReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult> => {
    const parsed = base.extend({ note: z.string().max(1000) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await setReturnAdminNote(
        getDb(),
        parsed.data.returnId,
        { label: subject.email },
        parsed.data.note,
      );
      await record(subject, "return.note", parsed.data.returnId);
      done(parsed.data.returnId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.note", entity: "return" },
);

export const refundReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult<{ amountMinor: number }>> => {
    const parsed = base
      .extend({
        shipping: z.string().max(20).optional(),
        shippingReason: z.string().max(300).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    // rambursarea cere și permisiunea de rambursare din comandă (rolul Suport o are, cu limită)
    if (!can(subject, "orders.refund")) return { ok: false, code: "forbidden" };
    let shippingMinor = 0;
    if (parsed.data.shipping && parsed.data.shipping.trim() !== "") {
      const minor = parseMoneyInput(parsed.data.shipping);
      if (minor === null || minor < 0) return { ok: false, code: "invalid" };
      shippingMinor = minor;
    }
    try {
      const result = await refundReturn(
        {
          db: getDb(),
          getProvider: (code: string) => getPaymentConfig().getProvider(code),
          now: () => new Date(),
          readLimitMinor: async () =>
            (await getSettings().getGroupUncached("payment")).supportRefundLimit,
        },
        {
          returnId: parsed.data.returnId,
          actorLabel: subject.email,
          // fără `payments.refund` (rolul Suport) rambursarea e CU LIMITĂ, ca la rambursarea din comandă
          actorUnlimited: can(subject, "payments.refund"),
          shippingMinor,
          ...(parsed.data.shippingReason ? { shippingReason: parsed.data.shippingReason } : {}),
        },
      );
      if (result.created) {
        await record(subject, "return.refund", parsed.data.returnId, {
          refundId: result.refundId,
          productsMinor: result.productsMinor,
          shippingMinor: result.shippingMinor,
          amountMinor: result.amountMinor,
          limited: !can(subject, "payments.refund"),
        });
      }
      done(parsed.data.returnId);
      return { ok: true, amountMinor: result.amountMinor };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.refund", entity: "return" },
);

export const restockReturnAction = withPermission(
  "returns.manage",
  async (raw: unknown, subject): Promise<ReturnActionResult<{ result: RestockResult }>> => {
    const parsed = base.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await restockReturn(
        getDb(),
        parsed.data.returnId,
        { id: subject.userId, label: subject.email },
        new Date(),
      );
      await record(subject, "return.restock", parsed.data.returnId, { ...result });
      done(parsed.data.returnId);
      return { ok: true, result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "return.restock", entity: "return" },
);
