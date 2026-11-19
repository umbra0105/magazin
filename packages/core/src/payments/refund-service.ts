import type { Prisma } from "@ecom/db";
import type { PaymentProvider, RefundOutcome } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { addOrderEvent, lockOrder, transitionOrder } from "../orders/order-service";
import { notifyAdmins } from "../notifications/admin-notifications";
import { PaymentError } from "./payment-errors";
import { flagAttention, lockPayment, resolveAttention } from "./payment-db";

/**
 * Rambursările (Faza 10). Reguli:
 *  - suma ≤ încasat − deja angajat, verificată pe server SUB BLOCARE (comanda, apoi plata) și garantată și de CHECK-ul din bază;
 *  - fiecare rambursare are cheie de idempotență (la cele automate, derivată din plată: o singură rambursare per plată și motiv);
 *  - apelul către procesator se face în AFARA tranzacției; cererea trimisă își păstrează `sentAt`: o cerere trimisă și rămasă fără
 *    rezultat NU se retrimite automat (risc de rambursare dublă), ci devine «manual_required»;
 *  - rezultatul NU se presupune: eroare, «viitor» sau răspuns neclar => «manual_required», vizibil în «necesită atenție»;
 *  - `paymentStatus` al comenzii trece prin `transitionOrder` doar după confirmare.
 */

export interface RefundDeps {
  db: Db;
  getProvider: (code: string) => Promise<PaymentProvider | null>;
  now: () => Date;
}

export interface CreateRefundInput {
  paymentId: string;
  amountMinor: number;
  reason: string;
  kind: "admin" | "auto_stock_lost" | "auto_late_payment";
  idempotencyKey: string;
  actorLabel?: string;
  /** Rambursare cerută de un actor CU LIMITĂ (Suport): se numără în limita de pe comandă (`order-refund.ts`). */
  limitedActor?: boolean;
}

export type RefundRow = Prisma.RefundGetPayload<object>;

/**
 * Creează cererea de rambursare în tranzacția apelantului, care ține deja blocată comanda (`lockOrder`). Idempotentă: aceeași
 * cheie întoarce cererea existentă, fără alt efect. Angajează suma pe plată (plafon).
 */
export async function createRefundInTx(
  tx: Db,
  input: CreateRefundInput,
  now: Date,
): Promise<{ refund: RefundRow; created: boolean }> {
  const existing = await tx.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { refund: existing, created: false };
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PaymentError("REFUND_INVALID", "Suma rambursării trebuie să fie pozitivă");
  }
  const reason = input.reason.trim();
  if (reason === "") throw new PaymentError("REFUND_INVALID", "Motivul rambursării lipsește");
  if (!(await lockPayment(tx, input.paymentId))) {
    throw new PaymentError("PAYMENT_NOT_FOUND", "Plata nu există");
  }
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  if (payment.status !== "paid" && payment.status !== "refunded") {
    throw new PaymentError("PAYMENT_NOT_REFUNDABLE", "Plata nu e încasată: nu se poate rambursa");
  }
  const remaining = payment.amountMinor - payment.refundCommittedMinor;
  if (input.amountMinor > remaining) {
    throw new PaymentError(
      "REFUND_EXCEEDS_PAID",
      "Suma depășește ce a rămas de rambursat din această plată",
      { remainingMinor: remaining },
    );
  }
  const refund = await tx.refund.create({
    data: {
      paymentId: payment.id,
      orderId: payment.orderId,
      amountMinor: input.amountMinor,
      reason,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
      ...(input.limitedActor ? { limitedActor: true } : {}),
    },
  });
  await tx.payment.update({
    where: { id: payment.id },
    data: { refundCommittedMinor: { increment: input.amountMinor } },
  });
  await addOrderEvent(tx, payment.orderId, {
    type: "refund.requested",
    message: "Rambursare cerută",
    data: { refundId: refund.id, amountMinor: input.amountMinor, kind: input.kind },
    ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
  });
  void now;
  return { refund, created: true };
}

/** Cererea de rambursare a adminului: blochează, verifică plafonul, creează cererea, apoi o trimite procesatorului. */
export async function requestRefund(
  deps: RefundDeps,
  input: Omit<CreateRefundInput, "kind"> & { actorLabel: string },
): Promise<{ refundId: string; created: boolean }> {
  const payment = await deps.db.payment.findUnique({
    where: { id: input.paymentId },
    select: { orderId: true },
  });
  if (!payment) throw new PaymentError("PAYMENT_NOT_FOUND", "Plata nu există");
  const result = await inTx(deps.db, async (tx) => {
    await lockOrder(tx, payment.orderId);
    return createRefundInTx(tx, { ...input, kind: "admin" }, deps.now());
  });
  if (result.created) await executeRefund(deps, result.refund.id);
  return { refundId: result.refund.id, created: result.created };
}

/** Efectele unei rambursări CONFIRMATE asupra plății și comenzii (în tranzacția apelantului, cu comanda și plata blocate). */
async function applyRefundConfirmed(tx: Db, refund: RefundRow, now: Date): Promise<void> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
  const confirmed = await tx.refund.aggregate({
    where: { paymentId: refund.paymentId, status: "confirmed" },
    _sum: { amountMinor: true },
  });
  const confirmedMinor = confirmed._sum.amountMinor ?? 0;
  const full = confirmedMinor >= payment.amountMinor;
  if (full && payment.status === "paid") {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "refunded" } });
  }
  const states = await lockOrder(tx, refund.orderId);
  // plata DUBLĂ (o altă tentativă a aceleiași comenzi a fost încasată mai devreme) se returnează fără să atingă starea de
  // plată a comenzii, care rămâne cea a plății care a confirmat-o
  const earlierPaid = payment.capturedAt
    ? await tx.payment.count({
        where: {
          orderId: refund.orderId,
          NOT: { id: payment.id },
          status: { in: ["paid", "refunded"] },
          OR: [
            { capturedAt: { lt: payment.capturedAt } },
            { capturedAt: payment.capturedAt, attemptNo: { lt: payment.attemptNo } },
          ],
        },
      })
    : 0;
  const isDuplicate = earlierPaid > 0;
  const message = full ? "Plata a fost rambursată integral" : "Plata a fost rambursată parțial";
  if (
    states &&
    !isDuplicate &&
    full &&
    (states.paymentStatus === "paid" || states.paymentStatus === "partially_refunded")
  ) {
    await transitionOrder(
      tx,
      refund.orderId,
      { paymentStatus: "refunded" },
      {
        type: "payment.refunded",
        message,
        data: { refundId: refund.id, amountMinor: refund.amountMinor },
      },
      now,
    );
  } else if (states && !isDuplicate && !full && states.paymentStatus === "paid") {
    await transitionOrder(
      tx,
      refund.orderId,
      { paymentStatus: "partially_refunded" },
      {
        type: "payment.refunded",
        message,
        data: { refundId: refund.id, amountMinor: refund.amountMinor },
      },
      now,
    );
  } else {
    await addOrderEvent(tx, refund.orderId, {
      type: "payment.refunded",
      message,
      data: { refundId: refund.id, amountMinor: refund.amountMinor },
    });
  }
  // nicio altă rambursare în așteptare sau eșuată: se închide și alerta plății
  const open = await tx.refund.count({
    where: {
      paymentId: refund.paymentId,
      status: { in: ["requested", "manual_required", "failed"] },
    },
  });
  // «comandă anulată cu plata încasată»: alerta se închide doar când banii s-au întors integral (o rambursare parțială nu o rezolvă)
  const keepsAlert = payment.attentionReason === "order_cancelled_paid" && !full;
  if (open === 0 && !keepsAlert) await resolveAttention(tx, refund.paymentId, now);
}

/** Confirmarea unei cereri de către procesator (notificare de credit), în tranzacția apelantului, cu comanda și plata blocate. */
export async function confirmRefundFromProvider(
  tx: Db,
  refund: RefundRow,
  providerRef: string | null,
  now: Date,
): Promise<void> {
  const updated = await tx.refund.update({
    where: { id: refund.id },
    data: { status: "confirmed", confirmedAt: now, ...(providerRef ? { providerRef } : {}) },
  });
  await applyRefundConfirmed(tx, updated, now);
}

/**
 * Trimite cererea procesatorului (în afara tranzacției) și scrie rezultatul. Idempotentă și sigură la apeluri simultane: doar
 * cine reușește să pună `sentAt` trimite. Întoarce starea finală a cererii.
 */
export async function executeRefund(deps: RefundDeps, refundId: string): Promise<RefundRow> {
  const claimed = await inTx(deps.db, async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw new PaymentError("REFUND_NOT_FOUND", "Rambursarea nu există");
    if (refund.status !== "requested" || refund.sentAt !== null) return { refund, send: false };
    const taken = await tx.refund.updateMany({
      where: { id: refundId, status: "requested", sentAt: null },
      data: { sentAt: deps.now() },
    });
    return { refund, send: taken.count === 1 };
  });
  if (!claimed.send) return claimed.refund;

  const payment = await deps.db.payment.findUniqueOrThrow({
    where: { id: claimed.refund.paymentId },
  });
  let outcome: RefundOutcome;
  try {
    const provider = await deps.getProvider(payment.provider);
    outcome =
      provider && payment.providerRef
        ? await provider.refund({
            providerRef: payment.providerRef,
            paymentRef: payment.id,
            refundRef: claimed.refund.idempotencyKey,
            amountMinor: claimed.refund.amountMinor,
            paymentAmountMinor: payment.amountMinor,
            currency: "RON",
            reason: claimed.refund.reason,
          })
        : {
            status: "manual_required",
            message:
              "Furnizorul de plată nu e configurat sau plata nu are referință la procesator: rambursează din contul procesatorului, apoi confirmă manual.",
          };
  } catch {
    outcome = {
      status: "manual_required",
      message:
        "Procesatorul nu a răspuns clar: verifică în contul lui dacă rambursarea a fost făcută înainte de a o repeta, apoi confirmă manual.",
    };
  }
  return finishRefund(deps, refundId, outcome);
}

async function finishRefund(
  deps: RefundDeps,
  refundId: string,
  outcome: RefundOutcome,
): Promise<RefundRow> {
  return inTx(deps.db, async (tx) => {
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    await lockOrder(tx, current.orderId);
    await lockPayment(tx, current.paymentId);
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status !== "requested") return refund; // altcineva a închis-o între timp (IPN de credit, confirmare manuală)
    const now = deps.now();
    if (outcome.status === "confirmed") {
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: {
          status: "confirmed",
          confirmedAt: now,
          ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
        },
      });
      await applyRefundConfirmed(tx, updated, now);
      return updated;
    }
    if (outcome.status === "pending") {
      return tx.refund.update({
        where: { id: refundId },
        data: outcome.providerRef ? { providerRef: outcome.providerRef } : {},
      });
    }
    if (outcome.status === "failed") {
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: { status: "failed", failureMessage: outcome.message.slice(0, 500) },
      });
      // suma nu mai e angajată: se poate cere din nou
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { refundCommittedMinor: { decrement: refund.amountMinor } },
      });
      await flagAttention(tx, refund.paymentId, "refund_failed", now);
      await addOrderEvent(tx, refund.orderId, {
        type: "refund.failed",
        message: "Procesatorul a refuzat rambursarea",
        data: { refundId, amountMinor: refund.amountMinor },
      });
      return updated;
    }
    const updated = await tx.refund.update({
      where: { id: refundId },
      data: { status: "manual_required", failureMessage: outcome.message.slice(0, 500) },
    });
    await flagAttention(tx, refund.paymentId, "refund_manual_required", now);
    await notifyAdmins(tx, {
      kind: "refund_manual",
      title: "O rambursare trebuie făcută manual",
      href: `/admin/comenzi/plati/${refund.paymentId}`,
      permission: "payments.refund",
      dedupKey: `refund-manual:${refundId}`,
    });
    await addOrderEvent(tx, refund.orderId, {
      type: "refund.manual_required",
      message: "Rambursarea trebuie făcută manual din contul procesatorului",
      data: { refundId, amountMinor: refund.amountMinor },
    });
    return updated;
  });
}

/**
 * «Am rambursat manual»: confirmă o cerere rămasă «manual_required» (sau trimisă și neconfirmată), cu referința din contul
 * procesatorului. Cere motiv/referință și actor (permisiunea de rambursare, confirmare și audit sunt la apelant).
 */
export async function confirmManualRefund(
  deps: RefundDeps,
  input: { refundId: string; reference: string; actorLabel: string },
): Promise<RefundRow> {
  const reference = input.reference.trim();
  if (reference === "") throw new PaymentError("REFUND_INVALID", "Referința rambursării lipsește");
  const found = await deps.db.refund.findUnique({ where: { id: input.refundId } });
  if (!found) throw new PaymentError("REFUND_NOT_FOUND", "Rambursarea nu există");
  return inTx(deps.db, async (tx) => {
    await lockOrder(tx, found.orderId);
    await lockPayment(tx, found.paymentId);
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: input.refundId } });
    if (refund.status === "confirmed") return refund; // idempotent
    const inFlight = refund.status === "requested" && refund.sentAt !== null;
    if (refund.status !== "manual_required" && !inFlight) {
      throw new PaymentError(
        "REFUND_NOT_MANUAL",
        "Doar o rambursare care cere acțiune manuală se poate confirma manual",
      );
    }
    const now = deps.now();
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: {
        status: "confirmed",
        confirmedAt: now,
        resolvedManually: true,
        manualReference: reference.slice(0, 200),
        actorLabel: input.actorLabel,
      },
    });
    await applyRefundConfirmed(tx, updated, now);
    return updated;
  });
}

/**
 * Curăță cererile rămase în aer: o cerere TRIMISĂ (`sentAt` setat) și nerezolvată de peste `staleMs` devine «manual_required»
 * (nu se retrimite: ar putea fi deja făcută); una NETRIMISĂ (proces oprit între creare și trimitere) se trimite acum.
 */
export async function sweepRefunds(
  deps: RefundDeps,
  options: { staleMs: number; unsentAfterMs: number; limit?: number },
): Promise<{ sent: number; escalated: number }> {
  const now = deps.now();
  const limit = options.limit ?? 50;
  const unsent = await deps.db.refund.findMany({
    where: {
      status: "requested",
      sentAt: null,
      createdAt: { lte: new Date(now.getTime() - options.unsentAfterMs) },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let sent = 0;
  for (const { id } of unsent) {
    const result = await executeRefund(deps, id);
    if (result.sentAt) sent += 1;
  }
  const stale = await deps.db.refund.findMany({
    where: {
      status: "requested",
      sentAt: { not: null, lte: new Date(now.getTime() - options.staleMs) },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let escalated = 0;
  for (const { id } of stale) {
    await finishRefund(deps, id, {
      status: "manual_required",
      message:
        "Rambursarea a fost trimisă procesatorului, dar nu s-a primit confirmarea: verifică în contul lui înainte de a o repeta, apoi confirmă manual.",
    });
    escalated += 1;
  }
  return { sent, escalated };
}
