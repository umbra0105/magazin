import type { Prisma } from "@ecom/db";
import { inTx, type Db } from "../db-tx";
import { OrderError } from "../orders/order-errors";
import { BANK_REFERENCE_MAX, BANK_REFERENCE_MIN } from "../orders/order-payments-admin";
import { lockOrder, transitionOrder } from "../orders/order-service";
import { flagAttention } from "../payments/payment-db";

/**
 * Reconcilierea rambursului (Faza 12, D7): comenzile cu ramburs EXPEDIATE și încă nevirate de curier, și acțiunea «Marchează
 * încasat» (suma, referința și data virării). Reface exact mecanismul «Marchează plătit» din Faza 11 (`markBankTransferPaid`), pentru
 * ramburs:
 *  - cere SUMA virată, REFERINȚA din extras și DATA;
 *  - o sumă diferită de totalul comenzii se REFUZĂ fără decizie explicită (`acceptDifference`); cu decizie, plata se înregistrează cu
 *    suma primită (`capturedAmountMinor`) și intră în «necesită atenție» (`amount_mismatch`), ca diferența să nu se piardă;
 *  - e idempotentă (o comandă deja încasată nu scrie alt eveniment) și sub blocarea comenzii;
 *  - NU adaugă reguli noi pe bani: fără comisioane, fără alt moment de încasare decât virarea confirmată de admin, fără recalculare
 *    de sume. Spre deosebire de transferul bancar, stocul nu se atinge (la ramburs stocul s-a angajat la plasare).
 * Evenimentul e `payment.cod_collected` (fără email către client: plata la curier a fost deja făcută la livrare); permisiunea
 * (`orders.mark_paid`) și auditul sunt ale acțiunii din admin.
 */
export interface CodRow {
  orderId: string;
  number: string;
  /** Totalul comenzii = ce trebuie să vireze curierul. */
  totalMinor: number;
  shipmentId: string;
  carrier: string;
  awb: string;
  shipmentStatus: string;
  shippedAt: Date;
  deliveredAt: Date | null;
}

/** Comenzile cu ramburs expediate (în tranzit sau livrate) și încă neîncasate, cele mai vechi întâi. */
export async function listCodReconciliation(
  db: Db,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: CodRow[]; total: number }> {
  const where: Prisma.OrderWhereInput = {
    paymentMethod: "cod",
    paymentStatus: "pending",
    status: { in: ["confirmed", "processing"] },
    fulfillmentStatus: { in: ["in_transit", "delivered"] },
    shipments: { some: { kind: "outbound", status: { not: "cancelled" } } },
  };
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: [{ placedAt: "asc" }, { id: "asc" }],
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
      select: {
        id: true,
        number: true,
        totalMinor: true,
        shipments: {
          where: { kind: "outbound", status: { not: "cancelled" } },
          take: 1,
          select: {
            id: true,
            carrier: true,
            awb: true,
            status: true,
            createdAt: true,
            deliveredAt: true,
          },
        },
      },
    }),
    db.order.count({ where }),
  ]);
  return {
    total,
    rows: rows.flatMap((order) => {
      const shipment = order.shipments[0];
      if (!shipment) return [];
      return [
        {
          orderId: order.id,
          number: order.number,
          totalMinor: order.totalMinor,
          shipmentId: shipment.id,
          carrier: shipment.carrier,
          awb: shipment.awb,
          shipmentStatus: shipment.status,
          shippedAt: shipment.createdAt,
          deliveredAt: shipment.deliveredAt,
        },
      ];
    }),
  };
}

export interface MarkCodCollectedInput {
  /** Suma virată de curier, în bani. */
  amountMinor: number;
  /** Referința operațiunii din extras. */
  reference: string;
  /** Data virării (nu în viitor, nu înaintea plasării comenzii). */
  collectedAt: Date;
  /** Decizia explicită de a înregistra o sumă diferită de total. */
  acceptDifference?: boolean;
  actorLabel: string;
  now: Date;
}

export interface MarkCodCollectedResult {
  alreadyPaid: boolean;
  differenceMinor: number;
}

export async function markCodCollected(
  db: Db,
  orderId: string,
  input: MarkCodCollectedInput,
): Promise<MarkCodCollectedResult> {
  const reference = input.reference.trim();
  if (reference.length < BANK_REFERENCE_MIN || reference.length > BANK_REFERENCE_MAX) {
    throw new OrderError(
      "ORDER_PAYMENT_REFERENCE_INVALID",
      `Referința din extras are între ${BANK_REFERENCE_MIN} și ${BANK_REFERENCE_MAX} de caractere`,
    );
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new OrderError("ORDER_PAYMENT_AMOUNT_INVALID", "Suma virată trebuie să fie pozitivă");
  }
  if (
    Number.isNaN(input.collectedAt.getTime()) ||
    input.collectedAt.getTime() > input.now.getTime()
  ) {
    throw new OrderError("ORDER_PAYMENT_DATE_INVALID", "Data virării nu poate fi în viitor");
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalMinor: true, paymentMethod: true, placedAt: true },
    });
    if (order.paymentMethod !== "cod") {
      throw new OrderError("ORDER_PAYMENT_NOT_PENDING", "Comanda nu se plătește cu ramburs");
    }
    if (states.paymentStatus === "paid") return { alreadyPaid: true, differenceMinor: 0 };
    if (input.collectedAt.getTime() < order.placedAt.getTime()) {
      throw new OrderError(
        "ORDER_PAYMENT_DATE_INVALID",
        "Data virării e înaintea plasării comenzii",
      );
    }
    if (
      states.paymentStatus !== "pending" ||
      !["confirmed", "processing"].includes(states.status) ||
      !["in_transit", "delivered"].includes(states.fulfillmentStatus)
    ) {
      throw new OrderError(
        "ORDER_PAYMENT_NOT_PENDING",
        "Rambursul se încasează doar pentru o comandă expediată și neplătită",
        { status: states.status, fulfillmentStatus: states.fulfillmentStatus },
      );
    }
    const difference = input.amountMinor - order.totalMinor;
    if (difference !== 0 && input.acceptDifference !== true) {
      throw new OrderError(
        "ORDER_PAYMENT_AMOUNT_MISMATCH",
        "Suma virată diferă de totalul comenzii: confirmă decizia explicit",
        {
          expectedMinor: order.totalMinor,
          receivedMinor: input.amountMinor,
          differenceMinor: difference,
        },
      );
    }
    const payment = await tx.payment.findFirstOrThrow({
      where: { orderId, status: "pending" },
      orderBy: { attemptNo: "asc" },
      select: { id: true },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "paid",
        capturedAt: input.collectedAt,
        capturedAmountMinor: input.amountMinor,
        capturedCurrency: "RON",
        rawPayload: { source: "admin", reference },
      },
    });
    await transitionOrder(
      tx,
      orderId,
      { paymentStatus: "paid" },
      {
        type: "payment.cod_collected",
        message:
          difference === 0
            ? "Rambursul a fost încasat (virat de curier) și înregistrat de admin"
            : "Rambursul a fost înregistrat de admin cu o sumă diferită de total",
        data: { reference, receivedMinor: input.amountMinor, differenceMinor: difference },
        actorLabel: input.actorLabel,
      },
      input.now,
    );
    if (difference !== 0) await flagAttention(tx, payment.id, "amount_mismatch", input.now);
    return { alreadyPaid: false, differenceMinor: difference };
  });
}
