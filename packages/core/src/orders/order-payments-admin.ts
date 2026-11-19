import { inTx, type Db } from "../db-tx";
import { flagAttention } from "../payments/payment-db";
import { OrderError } from "./order-errors";
import { confirmBankTransferPayment } from "./order-payments";
import { addOrderEvent, lockOrder } from "./order-service";

/**
 * «Marchează plătit» pentru transferul bancar (Faza 11): adminul a văzut banii în extrasul de cont. Peste `confirmBankTransferPayment`
 * (rezervarea devine angajare, plata încasată, comanda «confirmed», `OrderEvent` `payment.confirmed` → emailul «Plată primită»):
 *  - cere SUMA primită și REFERINȚA din extras;
 *  - o sumă diferită de totalul comenzii se REFUZĂ fără decizie explicită (`acceptDifference`); cu decizie, plata se înregistrează
 *    cu suma primită (`capturedAmountMinor`) și intră în «necesită atenție» (`amount_mismatch`), ca diferența să nu se piardă;
 *  - e idempotentă: o comandă deja plătită nu se modifică și nu scrie alt eveniment;
 *  - permisiunea (`orders.mark_paid`) și auditul sunt ale acțiunii din admin.
 */
export const BANK_REFERENCE_MIN = 3;
export const BANK_REFERENCE_MAX = 100;

export interface MarkTransferPaidInput {
  /** Suma primită în cont, în bani. */
  amountMinor: number;
  /** Referința operațiunii din extras (numărul ordinului, detaliile plății). */
  reference: string;
  /** Decizia explicită de a confirma o sumă diferită de total. */
  acceptDifference?: boolean;
  actorLabel: string;
  now: Date;
}

export interface MarkTransferPaidResult {
  alreadyPaid: boolean;
  differenceMinor: number;
}

export async function markBankTransferPaid(
  db: Db,
  orderId: string,
  input: MarkTransferPaidInput,
): Promise<MarkTransferPaidResult> {
  const reference = input.reference.trim();
  if (reference.length < BANK_REFERENCE_MIN || reference.length > BANK_REFERENCE_MAX) {
    throw new OrderError(
      "ORDER_PAYMENT_REFERENCE_INVALID",
      `Referința din extras are între ${BANK_REFERENCE_MIN} și ${BANK_REFERENCE_MAX} de caractere`,
    );
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new OrderError("ORDER_PAYMENT_AMOUNT_INVALID", "Suma primită trebuie să fie pozitivă");
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalMinor: true, paymentMethod: true },
    });
    if (order.paymentMethod !== "bank_transfer") {
      throw new OrderError(
        "ORDER_PAYMENT_NOT_PENDING",
        "Comanda nu se plătește prin transfer bancar",
      );
    }
    if (states.paymentStatus === "paid") return { alreadyPaid: true, differenceMinor: 0 };
    const difference = input.amountMinor - order.totalMinor;
    if (difference !== 0 && input.acceptDifference !== true) {
      throw new OrderError(
        "ORDER_PAYMENT_AMOUNT_MISMATCH",
        "Suma primită diferă de totalul comenzii: confirmă decizia explicit",
        {
          expectedMinor: order.totalMinor,
          receivedMinor: input.amountMinor,
          differenceMinor: difference,
        },
      );
    }
    await confirmBankTransferPayment(tx, orderId, { now: input.now, actorLabel: input.actorLabel });
    const payment = await tx.payment.findFirstOrThrow({
      where: { orderId, status: "paid" },
      orderBy: { attemptNo: "asc" },
      select: { id: true },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        capturedAmountMinor: input.amountMinor,
        capturedCurrency: "RON",
        rawPayload: { source: "admin", reference },
      },
    });
    if (difference !== 0) await flagAttention(tx, payment.id, "amount_mismatch", input.now);
    await addOrderEvent(tx, orderId, {
      type: "payment.transfer_recorded",
      message:
        difference === 0
          ? "Plata prin transfer bancar a fost înregistrată de admin"
          : "Plata prin transfer bancar a fost înregistrată de admin cu o sumă diferită de total",
      data: { reference, receivedMinor: input.amountMinor, differenceMinor: difference },
      actorLabel: input.actorLabel,
    });
    return { alreadyPaid: false, differenceMinor: difference };
  });
}
