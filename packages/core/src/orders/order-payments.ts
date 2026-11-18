import { inTx, type Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockService } from "../inventory/stock-service";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder, transitionOrder } from "./order-service";

/**
 * Confirmarea plății prin transfer bancar (Faza 9: DOAR în serviciu și în teste; ecranul «marchează plătit» din admin vine în
 * Faza 11). Blochează comanda, transformă rezervarea de stoc în angajare (`confirmReservation`), marchează plata ca încasată și
 * trece comanda în «confirmed». Idempotentă: o a doua confirmare nu face nimic.
 *
 * Dacă rezervarea a expirat și stocul s-a luat între timp, `confirmReservation` aruncă `STOCK_RESERVATION_LOST` și NU se
 * modifică nimic (banii trebuie rambursați; rambursarea vine în Fazele 10–11). O comandă deja anulată (inclusiv automat, la
 * expirarea termenului) nu se mai poate confirma.
 */
export async function confirmBankTransferPayment(
  db: Db,
  orderId: string,
  options: { now: Date; actorLabel?: string },
): Promise<{ alreadyPaid: boolean }> {
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentMethod: true, totalMinor: true },
    });
    if (order.paymentMethod !== "bank_transfer") {
      throw new OrderError(
        "ORDER_PAYMENT_NOT_PENDING",
        "Comanda nu se plătește prin transfer bancar",
      );
    }
    if (states.paymentStatus === "paid") return { alreadyPaid: true };
    if (states.status !== "pending" || states.paymentStatus !== "pending") {
      throw new OrderError(
        "ORDER_PAYMENT_NOT_PENDING",
        "Comanda nu mai așteaptă plata (e anulată sau în altă stare)",
        { status: states.status, paymentStatus: states.paymentStatus },
      );
    }
    const stock = new StockService({ db: tx, now: () => options.now });
    await stock.confirmReservation({ refType: ORDER_REF_TYPE, refId: orderId });
    await tx.payment.updateMany({
      where: { orderId, status: "pending" },
      data: { status: "paid", capturedAt: options.now },
    });
    await transitionOrder(
      tx,
      orderId,
      { status: "confirmed", paymentStatus: "paid" },
      {
        type: "payment.confirmed",
        message: "Plata prin transfer bancar a fost confirmată; stocul a fost angajat",
        data: { amountMinor: order.totalMinor },
        ...(options.actorLabel ? { actorLabel: options.actorLabel } : {}),
      },
      options.now,
    );
    return { alreadyPaid: false };
  });
}

export interface ExpireTransfersResult {
  cancelled: number;
  failed: number;
  /** Au mai rămas comenzi expirate (lot plin): următoarea rulare le preia. */
  more: boolean;
}

const DEFAULT_BATCH = 50;

/**
 * Anularea AUTOMATĂ a comenzilor cu transfer bancar al căror termen de rezervare a trecut fără plată: tranziție validată
 * (status, plată și livrare → «cancelled»), `OrderEvent`, eliberarea rezervării de stoc și plata marcată «cancelled». Idempotentă
 * și sigură la mai multe instanțe (fiecare comandă se blochează `FOR UPDATE` și se re-verifică înainte). O comandă care nu poate fi
 * anulată (eroare neprevăzută) nu le oprește pe celelalte.
 */
export async function expireDueTransferOrders(
  db: Db,
  options: { now: Date; limit?: number },
): Promise<ExpireTransfersResult> {
  const limit = options.limit ?? DEFAULT_BATCH;
  const due = await db.order.findMany({
    where: {
      status: "pending",
      paymentMethod: "bank_transfer",
      paymentStatus: "pending",
      reservationExpiresAt: { lte: options.now },
    },
    orderBy: [{ reservationExpiresAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true },
  });
  let cancelled = 0;
  let failed = 0;
  for (const { id } of due.slice(0, limit)) {
    try {
      const done = await inTx(db, async (tx) => {
        const states = await lockOrder(tx, id);
        // re-verificare sub blocare: între timp a fost plătită sau anulată
        if (!states || states.status !== "pending" || states.paymentStatus !== "pending")
          return false;
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          select: { reservationExpiresAt: true },
        });
        if (!order.reservationExpiresAt || order.reservationExpiresAt > options.now) return false;
        await transitionOrder(
          tx,
          id,
          { status: "cancelled", paymentStatus: "cancelled", fulfillmentStatus: "cancelled" },
          {
            type: "order.auto_cancelled",
            message: "Comandă anulată automat: termenul de plată prin transfer bancar a expirat",
            data: { reservationExpiresAt: order.reservationExpiresAt.toISOString() },
          },
          options.now,
        );
        const stock = new StockService({ db: tx, now: () => options.now });
        const released = await stock.release({ refType: ORDER_REF_TYPE, refId: id });
        await tx.payment.updateMany({
          where: { orderId: id, status: "pending" },
          data: { status: "cancelled" },
        });
        await addOrderEvent(tx, id, {
          type: "stock.released",
          message: "Rezervarea de stoc a fost eliberată",
          data: { released },
        });
        return true;
      });
      if (done) cancelled += 1;
    } catch {
      failed += 1;
    }
  }
  return { cancelled, failed, more: due.length > limit };
}
