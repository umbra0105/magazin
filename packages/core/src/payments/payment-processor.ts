import { randomUUID } from "node:crypto";
import type { Prisma } from "@ecom/db";
import { sha256Hex } from "@ecom/integrations";
import {
  WebhookRejectedError,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentProviderCode,
  type WebhookRejectReason,
  type WebhookRequest,
} from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockError } from "../inventory/stock-errors";
import { StockService } from "../inventory/stock-service";
import { addOrderEvent, lockOrder, transitionOrder } from "../orders/order-service";
import { flagAttention, lockPayment } from "./payment-db";
import type { AttentionReason } from "./payment-errors";
import {
  confirmRefundFromProvider,
  createRefundInTx,
  executeRefund,
  type RefundDeps,
  type RefundRow,
} from "./refund-service";

/**
 * Primirea și procesarea notificărilor de plată (webhook/IPN), Faza 10.
 *
 *  1. `ingestPaymentWebhook` (în ruta HTTP): verifică semnătura pe corpul BRUT, înregistrează evenimentul (unicitate pe
 *     (furnizor, eventId) = idempotență) și răspunde repede. Fără semnătură validă: respins, înregistrat (doar motivul și
 *     hash-ul corpului, fără conținut) și FĂRĂ niciun efect. Nu există cale fără semnătură.
 *  2. `processPaymentEvent` (coadă BullMQ sau măturătorul de siguranță): procesează ASINCRON, idempotent pe eveniment ȘI pe
 *     starea comenzii, sub blocarea comenzii. TOATE schimbările de stare ale comenzii trec prin `transitionOrder`.
 *
 * INVARIANT: niciun ban confirmat de procesator nu rămâne fără stare. După procesarea unui eveniment «plătit», fie comanda
 * e confirmată, fie plata are o rambursare (automată, idempotentă), fie e în «necesită atenție» (`checkMoneyInvariant`).
 */

export const MAX_EVENT_ATTEMPTS = 6;
/** Câte notificări respinse se înregistrează pe oră (peste, doar se refuză: baza nu crește la infinit sub atac). */
export const MAX_REJECTED_PER_HOUR = 1000;

export interface PaymentProcessorDeps {
  /** Clientul bazei (sau o tranzacție, în teste). */
  db: Db;
  getProvider: (code: string) => Promise<PaymentProvider | null>;
  now: () => Date;
  /** Pune evenimentul în coada de procesare (BullMQ). Dacă lipsește sau eșuează, măturătorul îl preia. */
  enqueue?: (eventId: string) => Promise<void>;
  /** Marchează furnizorul «verificat în sandbox» (plată în mod test confirmată cu semnătură validă). */
  markVerifiedInSandbox?: (code: PaymentProviderCode) => Promise<void>;
  /** Jurnal de audit de sistem (după comitere; best-effort, fără secrete). */
  audit?: (entry: {
    action: string;
    entityId: string;
    after: Record<string, unknown>;
  }) => Promise<void>;
}

export interface IngestResult {
  outcome: "accepted" | "duplicate" | "rejected";
  status: number;
  contentType: string;
  body: string;
  eventId?: string;
}

const REJECT_STATUS = 401;

async function recordRejected(
  deps: PaymentProcessorDeps,
  provider: string,
  request: WebhookRequest,
  reason: WebhookRejectReason,
): Promise<void> {
  const now = deps.now();
  try {
    // protecție la inundare: peste plafon, respingerile nu se mai înregistrează (răspunsul rămâne 401)
    const recent = await deps.db.paymentWebhookEvent.count({
      where: { status: "rejected", receivedAt: { gt: new Date(now.getTime() - 3_600_000) } },
    });
    if (recent >= MAX_REJECTED_PER_HOUR) return;
    await deps.db.paymentWebhookEvent.create({
      data: {
        provider,
        // un eveniment respins nu are identitate de încredere: cheia e proprie, ca să nu se piardă niciunul
        eventId: `rejected:${randomUUID()}`,
        status: "rejected",
        rejectReason: reason,
        bodyHash: sha256Hex(request.rawBody),
        processedAt: now,
      },
    });
  } catch {
    // înregistrarea unui eveniment respins nu trebuie să schimbe răspunsul (rămâne respingere)
  }
}

function normalizedOf(event: PaymentEvent): Prisma.InputJsonObject {
  return {
    paymentRef: event.paymentRef,
    providerRef: event.providerRef,
    outcome: event.outcome,
    rawStatus: event.rawStatus,
    amountMinor: event.amountMinor,
    currency: event.currency,
    cardLast4: event.cardLast4,
  };
}

export async function ingestPaymentWebhook(
  deps: PaymentProcessorDeps,
  providerCode: string,
  request: WebhookRequest,
): Promise<IngestResult> {
  const rejected = async (reason: WebhookRejectReason): Promise<IngestResult> => {
    await recordRejected(deps, providerCode, request, reason);
    return {
      outcome: "rejected",
      status: REJECT_STATUS,
      contentType: "text/plain; charset=utf-8",
      body: "Unauthorized",
    };
  };

  const provider = await deps.getProvider(providerCode);
  if (!provider) return rejected("not_configured");

  let verified;
  try {
    verified = await provider.verifyWebhook(request);
  } catch (error) {
    if (error instanceof WebhookRejectedError) return rejected(error.reason);
    return rejected("body_invalid");
  }

  const { event, response } = verified;
  const inserted = await deps.db.paymentWebhookEvent.createMany({
    data: [
      {
        provider: providerCode,
        eventId: event.eventId,
        status: "received",
        bodyHash: sha256Hex(request.rawBody),
        normalized: normalizedOf(event),
      },
    ],
    skipDuplicates: true,
  });
  const row = await deps.db.paymentWebhookEvent.findUniqueOrThrow({
    where: { provider_eventId: { provider: providerCode, eventId: event.eventId } },
    select: { id: true, status: true },
  });
  const duplicate = inserted.count === 0;
  // un eveniment deja primit și neprocesat (de exemplu retrimis de procesator) se pune din nou în coadă
  if (row.status === "received" || row.status === "failed") {
    try {
      await deps.enqueue?.(row.id);
    } catch {
      // coada indisponibilă: măturătorul îl preia
    }
  }
  return {
    outcome: duplicate ? "duplicate" : "accepted",
    status: response.status,
    contentType: response.contentType,
    body: response.body,
    eventId: row.id,
  };
}

// ----------------------------------------------------------------------------------------------------------- procesare

interface Effects {
  refundIds: string[];
  verifySandbox: PaymentProviderCode | null;
  audit: Array<{ action: string; entityId: string; after: Record<string, unknown> }>;
}

type PaymentRow = Prisma.PaymentGetPayload<object>;

const isStockLost = (error: unknown): boolean =>
  error instanceof StockError && error.code === "STOCK_RESERVATION_LOST";

interface NormalizedEvent {
  paymentRef: string;
  providerRef: string | null;
  outcome: PaymentEvent["outcome"];
  rawStatus: string;
  amountMinor: number | null;
  currency: string | null;
  cardLast4: string | null;
}

function readNormalized(value: Prisma.JsonValue | null): NormalizedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, Prisma.JsonValue>;
  if (typeof v["paymentRef"] !== "string" || typeof v["outcome"] !== "string") return null;
  return {
    paymentRef: v["paymentRef"],
    providerRef: typeof v["providerRef"] === "string" ? v["providerRef"] : null,
    outcome: v["outcome"] as PaymentEvent["outcome"],
    rawStatus: typeof v["rawStatus"] === "string" ? v["rawStatus"] : "",
    amountMinor: typeof v["amountMinor"] === "number" ? v["amountMinor"] : null,
    currency: typeof v["currency"] === "string" ? v["currency"] : null,
    cardLast4: typeof v["cardLast4"] === "string" ? v["cardLast4"] : null,
  };
}

async function setProviderRef(tx: Db, payment: PaymentRow, ref: string | null): Promise<void> {
  if (!ref || payment.providerRef === ref) return;
  const clash = await tx.payment.findFirst({
    where: { provider: payment.provider, providerRef: ref, NOT: { id: payment.id } },
    select: { id: true },
  });
  if (clash) return; // referința aparține altei plăți: nu se suprascrie
  await tx.payment.update({ where: { id: payment.id }, data: { providerRef: ref } });
}

async function markPaid(
  tx: Db,
  payment: PaymentRow,
  event: NormalizedEvent,
  now: Date,
): Promise<void> {
  await setProviderRef(tx, payment, event.providerRef);
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: "paid",
      capturedAt: now,
      capturedAmountMinor: event.amountMinor,
      capturedCurrency: event.currency,
      ...(event.cardLast4 ? { cardLast4: event.cardLast4 } : {}),
    },
  });
}

async function handlePaid(
  deps: PaymentProcessorDeps,
  tx: Db,
  payment: PaymentRow,
  event: NormalizedEvent,
  effects: Effects,
): Promise<void> {
  const now = deps.now();
  const orderId = payment.orderId;

  // 1. un eveniment «plătit» pentru o plată deja încasată cu aceeași sumă: duplicat, fără alt efect
  if (payment.status === "paid" || payment.status === "refunded") return;

  // 2. suma și moneda trebuie să fie EXACT cele ale plății (bani întregi, fără toleranță)
  if (event.currency !== "RON") {
    await tx.payment.update({
      where: { id: payment.id },
      data: { capturedAmountMinor: event.amountMinor, capturedCurrency: event.currency },
    });
    await flagAttention(tx, payment.id, "currency_mismatch", now);
    await addOrderEvent(tx, orderId, {
      type: "payment.attention",
      message:
        "Procesatorul a raportat o plată în altă monedă decât RON: comanda NU a fost confirmată",
      data: { reason: "currency_mismatch" },
    });
    effects.audit.push({
      action: "payment.attention",
      entityId: payment.id,
      after: { reason: "currency_mismatch" },
    });
    return;
  }
  if (event.amountMinor === null || event.amountMinor !== payment.amountMinor) {
    await tx.payment.update({
      where: { id: payment.id },
      data: { capturedAmountMinor: event.amountMinor, capturedCurrency: event.currency },
    });
    await flagAttention(tx, payment.id, "amount_mismatch", now);
    await addOrderEvent(tx, orderId, {
      type: "payment.attention",
      message:
        "Suma raportată de procesator diferă de totalul comenzii: comanda NU a fost confirmată",
      data: {
        reason: "amount_mismatch",
        expectedMinor: payment.amountMinor,
        reportedMinor: event.amountMinor,
      },
    });
    effects.audit.push({
      action: "payment.attention",
      entityId: payment.id,
      after: { reason: "amount_mismatch" },
    });
    return;
  }

  const states = await lockOrder(tx, orderId);
  if (!states) throw new Error("Comanda plății nu există");

  const attentionRefund = async (
    reason: AttentionReason,
    kind: "auto_stock_lost" | "auto_late_payment",
    key: string,
    message: string,
    eventType: string,
  ): Promise<RefundRow> => {
    const { refund } = await createRefundInTx(
      tx,
      {
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        reason: message,
        kind,
        idempotencyKey: key,
        actorLabel: "sistem",
      },
      now,
    );
    await flagAttention(tx, payment.id, reason, now);
    await addOrderEvent(tx, orderId, {
      type: eventType,
      message,
      data: { refundId: refund.id, reason },
    });
    effects.refundIds.push(refund.id);
    effects.audit.push({
      action: `payment.${reason}`,
      entityId: payment.id,
      after: { refundId: refund.id, amountMinor: payment.amountMinor },
    });
    return refund;
  };

  // A. comanda așteaptă plata: se confirmă (re-rezervând atomic dacă rezervarea a expirat și stocul încă există)
  if (states.status === "pending" && states.paymentStatus === "pending") {
    const stock = new StockService({ db: tx, now: () => now });
    try {
      await stock.confirmReservation({ refType: ORDER_REF_TYPE, refId: orderId });
    } catch (error) {
      if (!isStockLost(error)) throw error;
      // STOCK_RESERVATION_LOST: banii sunt luați, stocul nu mai e. Comanda se anulează, plata se rambursează automat.
      await markPaid(tx, payment, event, now);
      await transitionOrder(
        tx,
        orderId,
        { status: "cancelled", paymentStatus: "paid", fulfillmentStatus: "cancelled" },
        {
          type: "payment.stock_lost",
          message:
            "Plata a fost primită după expirarea rezervării, iar produsele nu mai sunt în stoc. Comanda a fost anulată, iar suma plătită va fi returnată.",
          data: { amountMinor: payment.amountMinor },
        },
        now,
      );
      await attentionRefund(
        "stock_reservation_lost",
        "auto_stock_lost",
        `auto:stock_lost:${payment.id}`,
        "Rambursare automată: plată primită după expirarea rezervării, fără stoc",
        "refund.auto_requested",
      );
      return;
    }
    await markPaid(tx, payment, event, now);
    // celelalte tentative rămase în așteptare nu mai au rost; jetoanele de reîncercare se invalidează
    await tx.payment.updateMany({
      where: { orderId, status: "pending", NOT: { id: payment.id } },
      data: { status: "cancelled" },
    });
    await tx.paymentRetryToken.updateMany({
      where: { orderId, usedAt: null },
      data: { usedAt: now },
    });
    await transitionOrder(
      tx,
      orderId,
      { status: "confirmed", paymentStatus: "paid" },
      {
        type: "payment.confirmed",
        message: "Plata cu cardul a fost confirmată; stocul a fost angajat",
        data: { amountMinor: payment.amountMinor, provider: payment.provider },
      },
      now,
    );
    if (
      payment.mode === "test" &&
      (payment.provider === "netopia" || payment.provider === "euplatesc")
    ) {
      effects.verifySandbox = payment.provider;
    }
    return;
  }

  // B. comanda e deja anulată (24 h expirate, anulare de admin): banii trebuie returnați
  if (states.status === "cancelled") {
    await markPaid(tx, payment, event, now);
    await attentionRefund(
      "late_payment_cancelled_order",
      "auto_late_payment",
      `auto:late:${payment.id}`,
      "Rambursare automată: plată primită pe o comandă deja anulată",
      "payment.late_cancelled",
    );
    return;
  }

  // C. comanda e deja plătită printr-o altă tentativă: plata dublă se returnează
  if (["paid", "partially_refunded", "refunded"].includes(states.paymentStatus)) {
    await markPaid(tx, payment, event, now);
    await attentionRefund(
      "duplicate_payment",
      "auto_late_payment",
      `auto:duplicate:${payment.id}`,
      "Rambursare automată: a doua plată pentru aceeași comandă",
      "payment.duplicate",
    );
    return;
  }

  // D. orice altă stare: nu se ghicește; plata rămâne vizibilă
  await tx.payment.update({
    where: { id: payment.id },
    data: { capturedAmountMinor: event.amountMinor, capturedCurrency: event.currency },
  });
  await flagAttention(tx, payment.id, "unexpected_order_state", now);
  await addOrderEvent(tx, orderId, {
    type: "payment.attention",
    message: "Plată confirmată de procesator pe o comandă într-o stare neașteptată",
    data: {
      reason: "unexpected_order_state",
      status: states.status,
      paymentStatus: states.paymentStatus,
    },
  });
}

async function handleFailed(
  deps: PaymentProcessorDeps,
  tx: Db,
  payment: PaymentRow,
  event: NormalizedEvent,
): Promise<void> {
  const now = deps.now();
  if (payment.status !== "pending") return; // deja încasată, eșuată sau anulată: ignorat (ordine inversă)
  await setProviderRef(tx, payment, event.providerRef);
  await tx.payment.update({
    where: { id: payment.id },
    data: { status: "failed", failureCode: event.rawStatus.slice(0, 60) },
  });
  const states = await lockOrder(tx, payment.orderId);
  if (states && states.status === "pending") {
    // stocul se eliberează imediat (reîncercarea îl rezervă din nou, doar dacă există)
    await new StockService({ db: tx, now: () => now }).release({
      refType: ORDER_REF_TYPE,
      refId: payment.orderId,
    });
    await addOrderEvent(tx, payment.orderId, {
      type: "payment.failed",
      message: "Plata cu cardul a eșuat sau a fost anulată; comanda așteaptă o nouă încercare",
      data: { provider: payment.provider, status: event.rawStatus },
    });
  }
}

async function handleCredit(
  deps: PaymentProcessorDeps,
  tx: Db,
  payment: PaymentRow,
  event: NormalizedEvent,
  effects: Effects,
): Promise<void> {
  const now = deps.now();
  const candidate = await tx.refund.findFirst({
    where: {
      paymentId: payment.id,
      amountMinor: event.amountMinor ?? -1,
      OR: [{ status: "manual_required" }, { status: "requested", sentAt: { not: null } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) {
    await flagAttention(tx, payment.id, "credit_unmatched", now);
    return;
  }
  await confirmRefundFromProvider(tx, candidate, event.providerRef, now);
  effects.audit.push({
    action: "refund.credit_notified",
    entityId: candidate.id,
    after: { paymentId: payment.id, amountMinor: candidate.amountMinor },
  });
}

export interface ProcessResult {
  status: "processed" | "skipped";
}

/**
 * Procesează un eveniment înregistrat. Idempotent: un eveniment deja procesat nu mai face nimic. Aruncă la eroare (coada
 * reîncearcă cu backoff); după `MAX_EVENT_ATTEMPTS` eșecuri rămâne «failed» = dead-letter vizibil în admin.
 */
export async function processPaymentEvent(
  deps: PaymentProcessorDeps,
  eventId: string,
): Promise<ProcessResult> {
  const row = await deps.db.paymentWebhookEvent.findUnique({ where: { id: eventId } });
  if (!row) return { status: "skipped" };
  if (row.status === "processed" || row.status === "rejected") return { status: "skipped" };
  const normalized = readNormalized(row.normalized);
  if (!normalized) {
    await deps.db.paymentWebhookEvent.update({
      where: { id: eventId },
      data: { status: "failed", attempts: { increment: 1 }, lastError: "EVENT_UNREADABLE" },
    });
    return { status: "skipped" };
  }

  const payment = await deps.db.payment.findUnique({ where: { id: normalized.paymentRef } });
  const effects: Effects = { refundIds: [], verifySandbox: null, audit: [] };
  try {
    if (!payment || payment.provider !== row.provider) {
      throw new Error("PAYMENT_NOT_FOUND");
    }
    const outcome = await inTx(deps.db, async (tx) => {
      await lockOrder(tx, payment.orderId);
      await lockPayment(tx, payment.id);
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM payment_webhook_event WHERE id = ${eventId} FOR UPDATE`;
      if (!locked[0] || locked[0].status === "processed" || locked[0].status === "rejected") {
        return "skipped" as const;
      }
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      switch (normalized.outcome) {
        case "paid":
          await handlePaid(deps, tx, fresh, normalized, effects);
          break;
        case "failed":
          await handleFailed(deps, tx, fresh, normalized);
          break;
        case "credit":
          await handleCredit(deps, tx, fresh, normalized, effects);
          break;
        case "pending":
          await setProviderRef(tx, fresh, normalized.providerRef);
          break;
        default:
          if (fresh.status === "pending") {
            await flagAttention(tx, fresh.id, "unknown_status", deps.now());
          }
      }
      await tx.paymentWebhookEvent.update({
        where: { id: eventId },
        data: {
          status: "processed",
          processedAt: deps.now(),
          paymentId: fresh.id,
          lastError: null,
          attempts: { increment: 1 },
        },
      });
      return "processed" as const;
    });
    if (outcome === "skipped") return { status: "skipped" };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "EVENT_ERROR";
    await deps.db.paymentWebhookEvent
      .update({
        where: { id: eventId },
        data: { status: "failed", attempts: { increment: 1 }, lastError: message },
      })
      .catch(() => undefined);
    throw error;
  }

  // după comitere: apeluri externe și efecte secundare, în afara tranzacției
  const refundDeps: RefundDeps = { db: deps.db, getProvider: deps.getProvider, now: deps.now };
  for (const refundId of effects.refundIds) {
    try {
      await executeRefund(refundDeps, refundId);
    } catch {
      // rămâne «requested»: măturătorul de rambursări o preia
    }
  }
  if (effects.verifySandbox && deps.markVerifiedInSandbox) {
    await deps.markVerifiedInSandbox(effects.verifySandbox).catch(() => undefined);
  }
  for (const entry of effects.audit) await deps.audit?.(entry).catch(() => undefined);
  return { status: "processed" };
}

/**
 * Măturătorul de siguranță: procesează evenimentele rămase «received» (coada indisponibilă) sau «failed» cu încercări rămase.
 * Cele care au epuizat încercările rămân «failed» = dead-letter vizibil în ecranul de plăți.
 */
export async function sweepPaymentEvents(
  deps: PaymentProcessorDeps,
  options: { olderThanMs: number; limit?: number },
): Promise<{ processed: number; failed: number }> {
  const cutoff = new Date(deps.now().getTime() - options.olderThanMs);
  const rows = await deps.db.paymentWebhookEvent.findMany({
    where: {
      OR: [
        { status: "received", receivedAt: { lte: cutoff } },
        { status: "failed", attempts: { lt: MAX_EVENT_ATTEMPTS }, receivedAt: { lte: cutoff } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true },
  });
  let processed = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      const result = await processPaymentEvent(deps, id);
      if (result.status === "processed") processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
