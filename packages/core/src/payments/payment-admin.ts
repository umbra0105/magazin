import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import type { AttentionReason } from "./payment-errors";
import { MAX_EVENT_ATTEMPTS } from "./payment-processor";

/**
 * Citirile pentru ecranele de plăți din admin (Faza 10): listă cu filtru «necesită atenție», detaliul unei plăți cu cronologie și
 * contoarele de sănătate (IPN-uri respinse, evenimente blocate). Nu conțin credențiale, `rawPayload` sau valori de card (doar
 * ultimele 4 cifre, dacă le-a trimis procesatorul).
 */

export type PaymentListView = "all" | "attention" | "refunds";

export interface PaymentListRow {
  id: string;
  orderId: string;
  orderNumber: string;
  provider: string;
  mode: string | null;
  attemptNo: number;
  amountMinor: number;
  status: string;
  refundCommittedMinor: number;
  cardLast4: string | null;
  attentionReason: AttentionReason | null;
  createdAt: Date;
}

export interface PaymentListResult {
  rows: PaymentListRow[];
  total: number;
  page: number;
  pageSize: number;
}

const openAttention: Prisma.PaymentWhereInput = {
  attentionReason: { not: null },
  attentionResolvedAt: null,
};

const openRefund: Prisma.PaymentWhereInput = {
  refunds: { some: { status: { in: ["requested", "manual_required", "failed"] } } },
};

function whereFor(view: PaymentListView): Prisma.PaymentWhereInput {
  const card: Prisma.PaymentWhereInput = { method: "card" };
  if (view === "attention") return { AND: [card, { OR: [openAttention, openRefund] }] };
  if (view === "refunds") return { AND: [card, { refunds: { some: {} } }] };
  return card;
}

export async function listPayments(
  db: Db,
  options: { view: PaymentListView; page: number; pageSize: number },
): Promise<PaymentListResult> {
  const where = whereFor(options.view);
  const pageSize = Math.min(Math.max(options.pageSize, 5), 100);
  const page = Math.max(options.page, 1);
  const [total, rows] = await Promise.all([
    db.payment.count({ where }),
    db.payment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        orderId: true,
        provider: true,
        mode: true,
        attemptNo: true,
        amountMinor: true,
        status: true,
        refundCommittedMinor: true,
        cardLast4: true,
        attentionReason: true,
        attentionResolvedAt: true,
        createdAt: true,
        order: { select: { number: true } },
      },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.number,
      provider: row.provider,
      mode: row.mode,
      attemptNo: row.attemptNo,
      amountMinor: row.amountMinor,
      status: row.status,
      refundCommittedMinor: row.refundCommittedMinor,
      cardLast4: row.cardLast4,
      attentionReason:
        row.attentionReason && !row.attentionResolvedAt
          ? (row.attentionReason as AttentionReason)
          : null,
      createdAt: row.createdAt,
    })),
  };
}

export interface PaymentCounters {
  /** Plăți cu motiv activ în «necesită atenție» sau cu rambursări deschise. */
  attention: number;
  /** IPN-uri/callback-uri respinse (semnătură invalidă etc.) în ultimele 24 h. */
  rejectedLast24h: number;
  /** Evenimente valide rămase neprocesate după toate încercările (dead-letter). */
  stuckEvents: number;
  /** Rambursări care cer acțiune manuală. */
  manualRefunds: number;
}

export async function paymentCounters(db: Db, now: Date): Promise<PaymentCounters> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const [attention, rejectedLast24h, stuckEvents, manualRefunds] = await Promise.all([
    db.payment.count({ where: whereFor("attention") }),
    db.paymentWebhookEvent.count({ where: { status: "rejected", receivedAt: { gt: since } } }),
    db.paymentWebhookEvent.count({
      where: { status: "failed", attempts: { gte: MAX_EVENT_ATTEMPTS } },
    }),
    db.refund.count({ where: { status: "manual_required" } }),
  ]);
  return { attention, rejectedLast24h, stuckEvents, manualRefunds };
}

export interface PaymentDetail {
  payment: {
    id: string;
    orderId: string;
    orderNumber: string;
    orderStatus: string;
    orderPaymentStatus: string;
    provider: string;
    mode: string | null;
    attemptNo: number;
    amountMinor: number;
    capturedAmountMinor: number | null;
    capturedCurrency: string | null;
    status: string;
    cardLast4: string | null;
    providerRef: string | null;
    failureCode: string | null;
    refundCommittedMinor: number;
    attentionReason: AttentionReason | null;
    attentionAt: Date | null;
    createdAt: Date;
    capturedAt: Date | null;
  };
  remainingRefundableMinor: number;
  refunds: Array<{
    id: string;
    amountMinor: number;
    reason: string;
    kind: string;
    status: string;
    failureMessage: string | null;
    manualReference: string | null;
    resolvedManually: boolean;
    actorLabel: string | null;
    createdAt: Date;
    confirmedAt: Date | null;
  }>;
  timeline: Array<{ id: string; type: string; message: string; createdAt: Date }>;
  attempts: Array<{ id: string; attemptNo: number; status: string; provider: string }>;
}

export async function paymentDetail(db: Db, paymentId: string): Promise<PaymentDetail | null> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: { id: true, number: true, status: true, paymentStatus: true } },
      refunds: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!payment) return null;
  const [events, attempts] = await Promise.all([
    db.orderEvent.findMany({
      where: { orderId: payment.orderId },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, message: true, createdAt: true },
    }),
    db.payment.findMany({
      where: { orderId: payment.orderId },
      orderBy: { attemptNo: "asc" },
      select: { id: true, attemptNo: true, status: true, provider: true },
    }),
  ]);
  return {
    payment: {
      id: payment.id,
      orderId: payment.orderId,
      orderNumber: payment.order.number,
      orderStatus: payment.order.status,
      orderPaymentStatus: payment.order.paymentStatus,
      provider: payment.provider,
      mode: payment.mode,
      attemptNo: payment.attemptNo,
      amountMinor: payment.amountMinor,
      capturedAmountMinor: payment.capturedAmountMinor,
      capturedCurrency: payment.capturedCurrency,
      status: payment.status,
      cardLast4: payment.cardLast4,
      providerRef: payment.providerRef,
      failureCode: payment.failureCode,
      refundCommittedMinor: payment.refundCommittedMinor,
      attentionReason:
        payment.attentionReason && !payment.attentionResolvedAt
          ? (payment.attentionReason as AttentionReason)
          : null,
      attentionAt: payment.attentionAt,
      createdAt: payment.createdAt,
      capturedAt: payment.capturedAt,
    },
    remainingRefundableMinor:
      payment.status === "paid"
        ? Math.max(payment.amountMinor - payment.refundCommittedMinor, 0)
        : 0,
    refunds: payment.refunds.map((refund) => ({
      id: refund.id,
      amountMinor: refund.amountMinor,
      reason: refund.reason,
      kind: refund.kind,
      status: refund.status,
      failureMessage: refund.failureMessage,
      manualReference: refund.manualReference,
      resolvedManually: refund.resolvedManually,
      actorLabel: refund.actorLabel,
      createdAt: refund.createdAt,
      confirmedAt: refund.confirmedAt,
    })),
    timeline: events,
    attempts,
  };
}

/** Evenimentele valide rămase blocate (dead-letter), pentru ecranul de plăți. */
export async function stuckPaymentEvents(db: Db, limit = 20) {
  return db.paymentWebhookEvent.findMany({
    where: { status: "failed", attempts: { gte: MAX_EVENT_ATTEMPTS } },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: {
      id: true,
      provider: true,
      attempts: true,
      lastError: true,
      receivedAt: true,
      paymentId: true,
    },
  });
}
