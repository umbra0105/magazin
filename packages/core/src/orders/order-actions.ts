import { inTx, type Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockService } from "../inventory/stock-service";
import { flagAttention } from "../payments/payment-db";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder, transitionOrder } from "./order-service";

/**
 * Acțiunile adminului asupra stării unei comenzi (Faza 11): «Anulează» și «Începe pregătirea». Fiecare trece prin `transitionOrder`
 * (state machine validat, `OrderEvent`) în tranzacția care ține comanda blocată; auditul din admin îl scrie acțiunea.
 *
 * ANULAREA unei comenzi PLĂTITE nu rambursează nimic automat (invariantul «niciun ban fără stare»): comanda devine «anulată», plata
 * rămâne «plătită» și intră în «necesită atenție» (`order_cancelled_paid`) până la rambursare; cere o decizie explicită
 * (`acknowledgePaid`). Stocul: rezervarea se eliberează, angajarea deschisă se eliberează (cea deja oglindită în SmartBill nu se
 * atinge: revine prin stornoul din SmartBill). Emailul «comandă anulată» pleacă din regula eveniment → email.
 */
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 300;

/** Stările de plată în care banii pot fi la noi: anularea cere atunci decizie explicită și lasă plata «de rambursat». */
const MONEY_HELD = new Set(["paid", "partially_refunded", "authorized"]);

export interface CancelOrderInput {
  reason: string;
  actorLabel: string;
  now: Date;
  /** Obligatoriu la o comandă plătită: «am înțeles că NU se rambursează automat». */
  acknowledgePaid?: boolean;
}

export interface CancelOrderResult {
  alreadyCancelled: boolean;
  /** Plata e încasată și încă nerambursată integral: apare ca «plătită, de rambursat». */
  needsRefund: boolean;
}

export async function cancelOrder(
  db: Db,
  orderId: string,
  input: CancelOrderInput,
): Promise<CancelOrderResult> {
  const reason = input.reason.trim();
  if (reason.length < CANCEL_REASON_MIN || reason.length > CANCEL_REASON_MAX) {
    throw new OrderError(
      "ORDER_CANCEL_INVALID",
      `Motivul anulării are între ${CANCEL_REASON_MIN} și ${CANCEL_REASON_MAX} de caractere`,
    );
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    if (states.status === "cancelled") {
      return { alreadyCancelled: true, needsRefund: await needsRefund(tx, orderId) };
    }
    if (!["pending", "confirmed", "processing"].includes(states.status)) {
      throw new OrderError("ORDER_CANCEL_INVALID", "Comanda nu mai poate fi anulată", {
        status: states.status,
      });
    }
    if (states.fulfillmentStatus !== "unfulfilled") {
      throw new OrderError(
        "ORDER_CANCEL_INVALID",
        "Comanda e deja expediată sau în curs de expediere: nu se anulează, se tratează ca retur",
        { fulfillmentStatus: states.fulfillmentStatus },
      );
    }
    const held = MONEY_HELD.has(states.paymentStatus);
    if (held && input.acknowledgePaid !== true) {
      throw new OrderError(
        "ORDER_CANCEL_PAID_NEEDS_DECISION",
        "Comanda e plătită: anularea NU o rambursează automat; confirmă decizia explicit",
        { paymentStatus: states.paymentStatus },
      );
    }
    const change: {
      status: "cancelled";
      fulfillmentStatus: "cancelled";
      paymentStatus?: "cancelled";
    } = { status: "cancelled", fulfillmentStatus: "cancelled" };
    if (states.paymentStatus === "pending") change.paymentStatus = "cancelled";
    await transitionOrder(
      tx,
      orderId,
      change,
      {
        type: "order.cancelled",
        message: held
          ? "Comandă anulată de admin; plata rămâne încasată, de rambursat"
          : "Comandă anulată de admin",
        data: { reason, paid: held },
        actorLabel: input.actorLabel,
      },
      input.now,
    );
    const stock = new StockService({ db: tx, now: () => input.now });
    const released = await stock.release({ refType: ORDER_REF_TYPE, refId: orderId });
    const committed = await stock.releaseCommitment({ refType: ORDER_REF_TYPE, refId: orderId });
    await tx.payment.updateMany({
      where: { orderId, status: "pending" },
      data: { status: "cancelled" },
    });
    await addOrderEvent(tx, orderId, {
      type: "stock.released",
      message: "Stocul comenzii anulate a fost eliberat",
      data: { released, committedReleased: committed.released },
    });
    if (held) {
      const paid = await tx.payment.findFirst({
        where: { orderId, status: { in: ["paid", "refunded"] } },
        orderBy: [{ capturedAt: "asc" }, { attemptNo: "asc" }],
        select: { id: true },
      });
      // banii rămân la noi: plata intră în «necesită atenție» până la rambursare (invariantul «niciun ban fără stare»)
      if (paid) await flagAttention(tx, paid.id, "order_cancelled_paid", input.now);
    }
    return { alreadyCancelled: false, needsRefund: held ? await needsRefund(tx, orderId) : false };
  });
}

/** `true` când comanda are plăți încasate cu sume neangajate în rambursări (de rambursat). */
export async function needsRefund(db: Db, orderId: string): Promise<boolean> {
  const payments = await db.payment.findMany({
    where: { orderId, status: { in: ["paid", "refunded"] } },
    select: { amountMinor: true, refundCommittedMinor: true },
  });
  return payments.some((p) => p.refundCommittedMinor < p.amountMinor);
}

/** `confirmed → processing` (pregătirea comenzii). Idempotent: o comandă deja în procesare nu schimbă nimic. */
export async function startProcessing(
  db: Db,
  orderId: string,
  input: { actorLabel: string; now: Date },
): Promise<{ alreadyProcessing: boolean }> {
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    if (states.status === "processing") return { alreadyProcessing: true };
    if (states.status !== "confirmed") {
      throw new OrderError(
        "ORDER_PROCESSING_INVALID",
        "Doar o comandă confirmată (plătită sau cu ramburs) trece în procesare",
        { status: states.status },
      );
    }
    await transitionOrder(
      tx,
      orderId,
      { status: "processing" },
      {
        type: "order.processing",
        message: "Comanda a intrat în procesare",
        actorLabel: input.actorLabel,
      },
      input.now,
    );
    return { alreadyProcessing: false };
  });
}
