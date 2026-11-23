import { inTx } from "../db-tx";
import { addOrderEvent, lockOrder } from "../orders/order-service";
import { requestOrderRefund, type OrderRefundDeps } from "../payments/order-refund";
import { DIGITAL_LINE_REFUND_KEY_PREFIX } from "./digital-grant";
import { DigitalError } from "./digital-errors";

/**
 * «Rambursează linia digitală» (Faza 14b): rambursează banii unei SINGURE linii digitale prin serviciul de rambursări existent
 * (`requestOrderRefund`: aceeași limită pentru Suport, aceeași idempotență, aceeași trimitere către procesator) și retrage accesul
 * la acea linie, nu la altele. Cheia de idempotență a rambursării poartă linia (`digital-line:<linie>`), deci:
 *  - apăsarea repetată întoarce aceeași rambursare, fără alt efect;
 *  - când rambursarea e CONFIRMATĂ, cârligul din `addOrderEvent` retrage din nou dreptul (idempotent), chiar dacă cererea a venit
 *    pe altă cale.
 * Accesul se retrage imediat ce rambursarea e CERUTĂ (nu așteaptă confirmarea procesatorului): clientul nu păstrează conținutul
 * câtă vreme banii se întorc. Dacă rambursarea eșuează, adminul poate restabili accesul (`restoreEntitlement`).
 */
export interface RefundDigitalLineInput {
  entitlementId: string;
  reason: string;
  actorLabel: string;
  /** Din permisiuni: `payments.refund` ⇒ fără limita rolului Suport. */
  actorUnlimited: boolean;
}

export interface RefundDigitalLineResult {
  refundId: string;
  created: boolean;
  amountMinor: number;
}

export async function refundDigitalLine(
  deps: OrderRefundDeps,
  input: RefundDigitalLineInput,
  now: Date,
): Promise<RefundDigitalLineResult> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 300) {
    throw new DigitalError("DIGITAL_INPUT_INVALID", "Motivul are între 3 și 300 de caractere");
  }
  const entitlement = await deps.db.digitalEntitlement.findUnique({
    where: { id: input.entitlementId },
    select: {
      id: true,
      orderId: true,
      orderLineId: true,
      revokedAt: true,
      orderLine: { select: { lineTotalMinor: true, isDigital: true } },
    },
  });
  if (!entitlement || !entitlement.orderLine.isDigital) {
    throw new DigitalError("DIGITAL_NOT_FOUND", "Dreptul de acces nu există");
  }
  const amountMinor = entitlement.orderLine.lineTotalMinor;
  const result = await requestOrderRefund(deps, {
    orderId: entitlement.orderId,
    amountMinor,
    reason: `Rambursare produs digital: ${reason}`,
    // o singură rambursare pe linie: apăsarea repetată o întoarce pe cea existentă
    idempotencyKey: `${DIGITAL_LINE_REFUND_KEY_PREFIX}${entitlement.orderLineId}`,
    actorLabel: input.actorLabel,
    actorUnlimited: input.actorUnlimited,
  });
  await inTx(deps.db, async (tx) => {
    await lockOrder(tx, entitlement.orderId);
    const revoked = await tx.digitalEntitlement.updateMany({
      where: { id: entitlement.id, revokedAt: null },
      data: {
        revokedAt: now,
        revokedReason: "Linia a fost rambursată",
        revokedBy: input.actorLabel,
      },
    });
    if (revoked.count > 0) {
      await addOrderEvent(tx, entitlement.orderId, {
        type: "digital.revoked",
        message: "Acces digital retras: linia a fost rambursată",
        data: { refundId: result.refundId },
        actorLabel: input.actorLabel,
      });
    }
  });
  return { refundId: result.refundId, created: result.created, amountMinor };
}
