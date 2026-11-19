"use server";

import { z } from "zod";
import {
  cancelOrder,
  can,
  clearSupplierMark,
  createSavedView,
  deleteSavedView,
  getAdminOrderDetail,
  markAtSupplier,
  renameSavedView,
  resendDispatch,
  startProcessing,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { TEMPLATE_CATALOG } from "@ecom/jobs";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { BULK_LIMIT } from "@/lib/order-bulk";
import { sanitizeSavedQuery } from "@/lib/order-list-params";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile listei de comenzi (Faza 11): previzualizarea din panoul lateral, acțiunile în MASĂ și vederile salvate. Acțiunile în
 * masă cer permisiunea acțiunii (verificată din nou pe server la fiecare apel), au o limită de selecție, se aplică fiecare comandă
 * separat (ordine stabilă, cu motivul refuzului pe comandă) și scriu audit pe comandă. Rambursarea NU e acțiune în masă. Anularea în
 * masă refuză comenzile plătite: acelea cer decizia explicită, una câte una.
 */

export type BulkOutcome = "ok" | "unchanged" | "refused";
export interface BulkRow {
  orderId: string;
  number: string;
  outcome: BulkOutcome;
  /** Cod stabil al refuzului (tradus în interfață). */
  reason?: "paid" | "invalid" | "notFound" | "noEmail" | "failed" | "forbidden";
}
export type BulkResult = { ok: true; rows: BulkRow[] } | { ok: false; code: "invalid" | "tooMany" };

const ids = z.array(z.string().min(1).max(64)).min(1);

async function eachOrder(
  rawIds: string[],
  run: (
    orderId: string,
    number: string,
  ) => Promise<{ outcome: BulkOutcome; reason?: BulkRow["reason"] }>,
): Promise<BulkResult> {
  const unique = [...new Set(rawIds)];
  if (unique.length > BULK_LIMIT) return { ok: false, code: "tooMany" };
  const db = getDb();
  const orders = await db.order.findMany({
    where: { id: { in: unique } },
    select: { id: true, number: true },
    orderBy: [{ number: "asc" }, { id: "asc" }],
  });
  const byId = new Map(orders.map((order) => [order.id, order.number]));
  const rows: BulkRow[] = [];
  for (const orderId of [...unique].sort()) {
    const number = byId.get(orderId);
    if (!number) {
      rows.push({ orderId, number: "—", outcome: "refused", reason: "notFound" });
      continue;
    }
    try {
      rows.push({ orderId, number, ...(await run(orderId, number)) });
    } catch (error) {
      const code = errorCodeOf(error, ["ORDER_", "PAYMENT_"]);
      rows.push({
        orderId,
        number,
        outcome: "refused",
        reason:
          code === "ORDER_CANCEL_PAID_NEEDS_DECISION"
            ? "paid"
            : code === "ORDER_NOT_FOUND"
              ? "notFound"
              : code
                ? "invalid"
                : "failed",
      });
    }
  }
  return { ok: true, rows };
}

const audit = (
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
    after: { ...after, bulk: true },
  });

export const bulkProcessAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<BulkResult> => {
    const parsed = z.strictObject({ ids }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    return eachOrder(parsed.data.ids, async (orderId) => {
      const result = await startProcessing(getDb(), orderId, {
        actorLabel: subject.email,
        now: new Date(),
      });
      if (result.alreadyProcessing) return { outcome: "unchanged" };
      await audit(subject, "order.processing", orderId);
      return { outcome: "ok" };
    });
  },
  { action: "order.bulk.processing", entity: "order" },
);

export const bulkCancelAction = withPermission(
  "orders.cancel",
  async (raw: unknown, subject): Promise<BulkResult> => {
    const parsed = z.strictObject({ ids, reason: z.string().max(500) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    return eachOrder(parsed.data.ids, async (orderId) => {
      const result = await cancelOrder(getDb(), orderId, {
        reason: parsed.data.reason,
        // în masă NU se acceptă decizia pentru comenzi plătite: acelea se anulează una câte una
        acknowledgePaid: false,
        actorLabel: subject.email,
        now: new Date(),
      });
      if (result.alreadyCancelled) return { outcome: "unchanged" };
      await audit(subject, "order.cancel", orderId, { needsRefund: result.needsRefund });
      return { outcome: "ok" };
    });
  },
  { action: "order.bulk.cancel", entity: "order" },
);

export const bulkSupplierAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<BulkResult> => {
    const parsed = z
      .strictObject({ ids, mode: z.enum(["mark", "clear"]), name: z.string().max(400) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    return eachOrder(parsed.data.ids, async (orderId) => {
      const now = new Date();
      if (parsed.data.mode === "clear") {
        const result = await clearSupplierMark(getDb(), orderId, {
          actorLabel: subject.email,
          now,
        });
        if (!result.changed) return { outcome: "unchanged" };
        await audit(subject, "order.supplier.clear", orderId);
        return { outcome: "ok" };
      }
      const result = await markAtSupplier(getDb(), orderId, {
        supplierName: parsed.data.name,
        note: null,
        actorLabel: subject.email,
        now,
      });
      if (!result.changed) return { outcome: "unchanged" };
      await audit(subject, "order.supplier.mark", orderId);
      return { outcome: "ok" };
    });
  },
  { action: "order.bulk.supplier", entity: "order" },
);

const CUSTOMER_TEMPLATES = TEMPLATE_CATALOG.filter((t) => t.wired && t.audience === "customer").map(
  (t) => t.key,
);

export const bulkResendAction = withPermission(
  "orders.write",
  async (raw: unknown, subject): Promise<BulkResult> => {
    const parsed = z.strictObject({ ids, template: z.string().max(80) }).safeParse(raw);
    if (!parsed.success || !CUSTOMER_TEMPLATES.includes(parsed.data.template as never)) {
      return { ok: false, code: "invalid" };
    }
    return eachOrder(parsed.data.ids, async (orderId) => {
      // cel mai recent email al acestui șablon, deja încheiat (trimis, eșuat sau omis); un rând în curs nu se retrimite
      const row = await getDb().emailDispatch.findFirst({
        where: {
          orderId,
          template: parsed.data.template,
          audience: "customer",
          status: { in: ["sent", "failed", "skipped"] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (!row) return { outcome: "refused", reason: "noEmail" };
      const result = await resendDispatch(getDb(), row.id, { actorLabel: subject.email });
      if (!result) return { outcome: "refused", reason: "noEmail" };
      await audit(subject, "order.email.resend", orderId, { template: parsed.data.template });
      return { outcome: "ok" };
    });
  },
  { action: "order.bulk.resend", entity: "order" },
);

// --- previzualizare în panoul lateral ---------------------------------------------------------------------------------

export interface OrderPreview {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  placedAt: string;
  totalMinor: number;
  lines: {
    title: string;
    variantTitle: string | null;
    quantityTicks: string;
    unitSymbol: string;
  }[];
  delivery: { kind: string; text: string };
  supplier: boolean;
  email: string | null;
}
export type PreviewResult = { ok: true; preview: OrderPreview } | { ok: false };

export const previewOrderAction = withPermission(
  "orders.read",
  async (raw: unknown, subject): Promise<PreviewResult> => {
    const parsed = z.strictObject({ orderId: z.string().min(1).max(64) }).safeParse(raw);
    if (!parsed.success) return { ok: false };
    const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
    const detail = await getAdminOrderDetail(getDb(), parsed.data.orderId, {
      pii,
      payments: false,
      emails: false,
    });
    if (!detail) return { ok: false };
    const shipping = detail.addresses?.find((a) => a.kind === "shipping");
    return {
      ok: true,
      preview: {
        id: detail.id,
        number: detail.number,
        status: detail.status,
        paymentStatus: detail.paymentStatus,
        fulfillmentStatus: detail.fulfillmentStatus,
        paymentMethod: detail.paymentMethod,
        placedAt: detail.placedAt.toISOString(),
        totalMinor: detail.totals.totalMinor,
        lines: detail.lines.map((line) => ({
          title: line.title,
          variantTitle: line.variantTitle,
          quantityTicks: line.quantityTicks,
          unitSymbol: line.unitSymbol,
        })),
        delivery:
          detail.shipping.kind === "pickup"
            ? { kind: "pickup", text: detail.shipping.pickupAddressText ?? "" }
            : {
                kind: "courier",
                text: shipping
                  ? `${shipping.localityName}, ${shipping.countyName}`
                  : detail.shipping.carrier,
              },
        supplier: detail.supplier !== null,
        email: detail.contact?.email ?? null,
      },
    };
  },
  { action: "order.preview", entity: "order" },
);

// --- vederi salvate ---------------------------------------------------------------------------------------------------

export type ViewResult =
  | { ok: true; id?: string }
  | { ok: false; code: "name" | "duplicate" | "limit" | "notFound" | "failed" };

const viewName = z.string().max(200);

function viewFailure(error: unknown): ViewResult {
  const code = errorCodeOf(error, ["ORDER_"]);
  if (code === "ORDER_VIEW_INVALID") return { ok: false, code: "name" };
  if (code === "ORDER_VIEW_DUPLICATE") return { ok: false, code: "duplicate" };
  if (code === "ORDER_VIEW_LIMIT") return { ok: false, code: "limit" };
  if (code === "ORDER_VIEW_NOT_FOUND") return { ok: false, code: "notFound" };
  return { ok: false, code: "failed" };
}

export const saveViewAction = withPermission(
  "orders.read",
  async (raw: unknown, subject): Promise<ViewResult> => {
    const parsed = z.strictObject({ name: viewName, query: z.string().max(2000) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      // doar parametrii de filtru cunoscuți se păstrează într-o vedere
      const view = await createSavedView(getDb(), subject.userId, {
        name: parsed.data.name,
        query: sanitizeSavedQuery(parsed.data.query),
      });
      return { ok: true, id: view.id };
    } catch (error) {
      return viewFailure(error);
    }
  },
  { action: "order.view.save", entity: "order" },
);

export const renameViewAction = withPermission(
  "orders.read",
  async (raw: unknown, subject): Promise<ViewResult> => {
    const parsed = z.strictObject({ id: z.string().min(1).max(64), name: viewName }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await renameSavedView(getDb(), subject.userId, parsed.data.id, parsed.data.name);
      return { ok: true };
    } catch (error) {
      return viewFailure(error);
    }
  },
  { action: "order.view.rename", entity: "order" },
);

export const deleteViewAction = withPermission(
  "orders.read",
  async (raw: unknown, subject): Promise<ViewResult> => {
    const parsed = z.strictObject({ id: z.string().min(1).max(64) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await deleteSavedView(getDb(), subject.userId, parsed.data.id);
      return { ok: true };
    } catch (error) {
      return viewFailure(error);
    }
  },
  { action: "order.view.delete", entity: "order" },
);
