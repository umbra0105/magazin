import { inTx } from "../db-tx";
import { lockOrder } from "../orders/order-service";
import { PaymentError } from "./payment-errors";
import { decideRefundLimit } from "./refund-limit";
import {
  createRefundInTx,
  executeRefund,
  type CreateRefundInput,
  type RefundDeps,
} from "./refund-service";

/**
 * Rambursarea cerută din DETALIUL COMENZII (Faza 11). Alege plata încasată a comenzii (nu o primește de la client), aplică limita
 * rolului Suport (`refund-limit.ts`) SUB BLOCAREA comenzii, creează cererea cu același serviciu ca ecranul de plăți și o trimite
 * procesatorului. Rambursarea face DOAR banii (nu atinge stocul și nu înregistrează un retur).
 *
 * `actorUnlimited` îl calculează apelantul din permisiuni (`payments.refund` ⇒ fără limită); `readLimitMinor` citește setarea
 * `payment.supportRefundLimit` și e apelată doar pentru actorul cu limită. O eroare la citire = «limită indisponibilă» (refuz).
 */
export interface OrderRefundDeps extends RefundDeps {
  readLimitMinor: () => Promise<number | null>;
}

export interface RequestOrderRefundInput {
  orderId: string;
  amountMinor: number;
  reason: string;
  idempotencyKey: string;
  actorLabel: string;
  actorUnlimited: boolean;
}

export async function requestOrderRefund(
  deps: OrderRefundDeps,
  input: RequestOrderRefundInput,
): Promise<{ refundId: string; created: boolean; paymentId: string }> {
  let limitMinor: number | null = null;
  if (!input.actorUnlimited) {
    try {
      limitMinor = await deps.readLimitMinor();
    } catch {
      limitMinor = null;
    }
  }
  const result = await inTx(deps.db, async (tx) => {
    const states = await lockOrder(tx, input.orderId);
    if (!states) throw new PaymentError("PAYMENT_NOT_FOUND", "Comanda sau plata nu există");
    // aceeași cerere repetată (dublu-click): întoarce cererea existentă, fără alt efect și fără o nouă verificare a limitei
    const existing = await tx.refund.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return { refund: existing, created: false, paymentId: existing.paymentId };
    }
    const payment = await tx.payment.findFirst({
      where: { orderId: input.orderId, status: { in: ["paid", "refunded"] } },
      orderBy: [{ capturedAt: "asc" }, { attemptNo: "asc" }],
      select: { id: true },
    });
    if (!payment) {
      throw new PaymentError(
        "PAYMENT_NOT_REFUNDABLE",
        "Comanda nu are o plată încasată de rambursat",
      );
    }
    const committed = await tx.refund.aggregate({
      where: { orderId: input.orderId, limitedActor: true, status: { not: "failed" } },
      _sum: { amountMinor: true },
    });
    const decision = decideRefundLimit({
      actorUnlimited: input.actorUnlimited,
      limitMinor,
      alreadyLimitedMinor: committed._sum.amountMinor ?? 0,
      amountMinor: input.amountMinor,
    });
    if (!decision.allowed) {
      if (decision.reason === "limit_unavailable") {
        throw new PaymentError(
          "REFUND_LIMIT_UNAVAILABLE",
          "Limita de rambursare nu poate fi citită: rambursarea e refuzată",
        );
      }
      if (decision.reason === "over_limit") {
        throw new PaymentError(
          "REFUND_OVER_LIMIT",
          "Suma depășește limita de rambursare a rolului tău",
          { remainingMinor: decision.remainingMinor, limitMinor },
        );
      }
      throw new PaymentError("REFUND_INVALID", "Suma rambursării trebuie să fie pozitivă");
    }
    const create: CreateRefundInput = {
      paymentId: payment.id,
      amountMinor: input.amountMinor,
      reason: input.reason,
      kind: "admin",
      idempotencyKey: input.idempotencyKey,
      actorLabel: input.actorLabel,
      limitedActor: !input.actorUnlimited,
    };
    const created = await createRefundInTx(tx, create, deps.now());
    return { refund: created.refund, created: created.created, paymentId: payment.id };
  });
  if (result.created) await executeRefund(deps, result.refund.id);
  return { refundId: result.refund.id, created: result.created, paymentId: result.paymentId };
}
