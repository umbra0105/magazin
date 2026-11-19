import type { Db } from "../db-tx";

/**
 * INVARIANTUL Fazei 10: niciun ban confirmat de procesator nu rămâne fără stare. O plată cu bani luați este în exact una dintre
 * stările:
 *  - `confirmed`: comanda e confirmată (neanulată) și plata e încasată;
 *  - `refunded`: există rambursări care acoperă toată suma (cerute, confirmate sau manuale);
 *  - `attention`: e în «necesită atenție» (motiv activ), vizibilă adminului.
 * Altfel e o încălcare (`violation`). Plata fără bani luați (`unpaid`) nu are nimic de păzit.
 */
export type MoneyState = "unpaid" | "confirmed" | "refunded" | "attention" | "violation";

export async function checkMoneyInvariant(db: Db, paymentId: string): Promise<MoneyState> {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { order: { select: { status: true, paymentStatus: true } } },
  });
  const captured =
    payment.status === "paid" ||
    payment.status === "refunded" ||
    payment.capturedAmountMinor !== null;
  const attentionActive = payment.attentionReason !== null && payment.attentionResolvedAt === null;
  // o plată «plătită» la procesator, dar fără sumă cunoscută, nu are `captured` și e totuși semnalată: rămâne vizibilă
  if (!captured) return attentionActive ? "attention" : "unpaid";
  if (
    payment.order.status !== "cancelled" &&
    ["paid", "partially_refunded", "refunded"].includes(payment.order.paymentStatus) &&
    (payment.status === "paid" || payment.status === "refunded")
  ) {
    return "confirmed";
  }
  if (payment.refundCommittedMinor >= payment.amountMinor) return "refunded";
  if (attentionActive) return "attention";
  return "violation";
}
