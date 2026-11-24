"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  can,
  extendEntitlement,
  refundDigitalLine,
  resetDownloads,
  restoreEntitlement,
  revokeEntitlement,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { getPaymentConfig } from "@/lib/payments";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului pe un drept de acces digital (Faza 14b): resetarea contorului, prelungirea, revocarea, restabilirea și
 * rambursarea unei linii digitale. Toate cer `digital.manage` (verificată din nou pe server); rambursarea cere ȘI `orders.refund` și
 * trece prin serviciul din Faza 10 (aceeași limită pentru Suport, aceeași idempotență). Auditul: actorul, acțiunea, dreptul și
 * comanda; NICIODATĂ motivul scris liber, emailul clientului sau cheile de stocare.
 */
type Fail = { ok: false; code: string };
export type EntitlementActionResult<T = object> = ({ ok: true } & T) | Fail;

const id = z.string().min(1).max(64);
const reason = z.string().min(1).max(400);
const PREFIXES = ["DIGITAL_", "REFUND_", "PAYMENT_", "ORDER_"] as const;

const failure = (error: unknown): Fail => ({
  ok: false,
  code: errorCodeOf(error, PREFIXES) ?? "failed",
});

async function context(entitlementId: string): Promise<{ orderId: string } | null> {
  const found = await getDb().digitalEntitlement.findUnique({
    where: { id: entitlementId },
    select: { orderId: true },
  });
  return found;
}

const record = (
  subject: { userId: string; email: string },
  action: string,
  entitlementId: string,
  orderId: string,
  after: Record<string, unknown> = {},
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "digital_entitlement",
    entityId: entitlementId,
    after: { orderId, ...after },
  });

const done = (orderId: string): void => {
  revalidatePath(`/admin/comenzi/${orderId}`);
  revalidatePath("/admin/comenzi/digital");
};

export const resetDownloadsAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<EntitlementActionResult> => {
    const parsed = z.strictObject({ entitlementId: id, reason }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const ctx = await context(parsed.data.entitlementId);
      if (!ctx) return { ok: false, code: "DIGITAL_NOT_FOUND" };
      await resetDownloads(getDb(), parsed.data.entitlementId, parsed.data.reason, {
        label: subject.email,
      });
      await record(subject, "digital.entitlement.reset", parsed.data.entitlementId, ctx.orderId);
      done(ctx.orderId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.entitlement.reset", entity: "digital_entitlement" },
);

export const extendEntitlementAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<EntitlementActionResult> => {
    const parsed = z
      .strictObject({
        entitlementId: id,
        reason,
        addDownloads: z.number().int().min(1).max(10_000).optional(),
        unlimited: z.boolean().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const ctx = await context(parsed.data.entitlementId);
      if (!ctx) return { ok: false, code: "DIGITAL_NOT_FOUND" };
      await extendEntitlement(
        getDb(),
        parsed.data.entitlementId,
        {
          ...(parsed.data.addDownloads !== undefined
            ? { addDownloads: parsed.data.addDownloads }
            : {}),
          ...(parsed.data.unlimited ? { unlimited: true } : {}),
        },
        parsed.data.reason,
        { label: subject.email },
      );
      await record(subject, "digital.entitlement.extend", parsed.data.entitlementId, ctx.orderId, {
        addDownloads: parsed.data.addDownloads ?? null,
        unlimited: parsed.data.unlimited === true,
      });
      done(ctx.orderId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.entitlement.extend", entity: "digital_entitlement" },
);

export const revokeEntitlementAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<EntitlementActionResult> => {
    const parsed = z.strictObject({ entitlementId: id, reason }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const ctx = await context(parsed.data.entitlementId);
      if (!ctx) return { ok: false, code: "DIGITAL_NOT_FOUND" };
      await revokeEntitlement(
        getDb(),
        parsed.data.entitlementId,
        parsed.data.reason,
        { label: subject.email },
        new Date(),
      );
      await record(subject, "digital.entitlement.revoke", parsed.data.entitlementId, ctx.orderId);
      done(ctx.orderId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.entitlement.revoke", entity: "digital_entitlement" },
);

export const restoreEntitlementAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<EntitlementActionResult> => {
    const parsed = z.strictObject({ entitlementId: id, reason }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const ctx = await context(parsed.data.entitlementId);
      if (!ctx) return { ok: false, code: "DIGITAL_NOT_FOUND" };
      await restoreEntitlement(getDb(), parsed.data.entitlementId, parsed.data.reason, {
        label: subject.email,
      });
      await record(subject, "digital.entitlement.restore", parsed.data.entitlementId, ctx.orderId);
      done(ctx.orderId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.entitlement.restore", entity: "digital_entitlement" },
);

export const refundDigitalLineAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<EntitlementActionResult<{ amountMinor: number }>> => {
    const parsed = z.strictObject({ entitlementId: id, reason }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    // rambursarea cere și permisiunea de rambursare din comandă (rolul Suport o are, cu limită)
    if (!can(subject, "orders.refund")) return { ok: false, code: "forbidden" };
    try {
      const ctx = await context(parsed.data.entitlementId);
      if (!ctx) return { ok: false, code: "DIGITAL_NOT_FOUND" };
      const result = await refundDigitalLine(
        {
          db: getDb(),
          getProvider: (code: string) => getPaymentConfig().getProvider(code),
          now: () => new Date(),
          readLimitMinor: async () =>
            (await getSettings().getGroupUncached("payment")).supportRefundLimit,
        },
        {
          entitlementId: parsed.data.entitlementId,
          reason: parsed.data.reason,
          actorLabel: subject.email,
          // fără `payments.refund` (rolul Suport) rambursarea e CU LIMITĂ, ca la rambursarea din comandă
          actorUnlimited: can(subject, "payments.refund"),
        },
        new Date(),
      );
      await record(subject, "digital.entitlement.refund", parsed.data.entitlementId, ctx.orderId, {
        refundId: result.refundId,
        amountMinor: result.amountMinor,
      });
      done(ctx.orderId);
      return { ok: true, amountMinor: result.amountMinor };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.entitlement.refund", entity: "digital_entitlement" },
);
