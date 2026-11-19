import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { notifyAdmins } from "../notifications/admin-notifications";
import type { AttentionReason } from "./payment-errors";

/** Blochează rândul plății (`FOR UPDATE`). Ordinea blocărilor: ÎNTÂI comanda (`lockOrder`), apoi plata, apoi cererile de rambursare. */
export async function lockPayment(tx: Db, paymentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM payment WHERE id = ${paymentId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Pune plata în «necesită atenție» (motiv + moment). Nu suprascrie un motiv deja activ (primul motiv rămâne vizibil, nu se
 * pierde); un motiv rezolvat poate fi înlocuit.
 */
export async function flagAttention(
  tx: Db,
  paymentId: string,
  reason: AttentionReason,
  now: Date,
): Promise<void> {
  const flagged = await tx.payment.updateMany({
    where: {
      id: paymentId,
      OR: [{ attentionReason: null }, { attentionResolvedAt: { not: null } }],
    },
    data: { attentionReason: reason, attentionAt: now, attentionResolvedAt: null },
  });
  // notificare internă o singură dată pe (plată, motiv): fără date personale în titlu, doar legătura spre plată
  if (flagged.count === 1) {
    await notifyAdmins(tx, {
      kind: "payment_attention",
      title: "O plată necesită atenție",
      href: `/admin/comenzi/plati/${paymentId}`,
      permission: "payments.read",
      dedupKey: `payment-attention:${paymentId}:${reason}:${now.getTime()}`,
    });
  }
}

/** Marchează rezolvat motivul activ (rămâne în istoric: `attentionResolvedAt`). */
export async function resolveAttention(tx: Db, paymentId: string, now: Date): Promise<void> {
  await tx.payment.updateMany({
    where: { id: paymentId, attentionReason: { not: null }, attentionResolvedAt: null },
    data: { attentionResolvedAt: now },
  });
}

/** Instantaneul sigur al unui eveniment pentru `OrderEvent.data`/`normalized`: nicio valoare secretă, doar câmpuri cunoscute. */
export function jsonOf(
  value: Record<string, string | number | boolean | null>,
): Prisma.InputJsonObject {
  return value;
}
