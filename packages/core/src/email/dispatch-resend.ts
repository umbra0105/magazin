import type { Prisma } from "@ecom/db";
import { inTx, type Db } from "../db-tx";
import { addOrderEvent } from "../orders/order-service";

/**
 * «Retrimite email»: o acțiune separată, cu eveniment propriu (`resend:<id nou>`, deci nu e blocată de unicitate), `OrderEvent`
 * și, la apelant, audit. Se poate retrimite orice rând care nu e în curs (`queued` sau `sending`).
 */
export async function resendDispatch(
  db: Db,
  id: string,
  options: { actorLabel: string },
): Promise<{ newId: string } | null> {
  return inTx(db, async (tx) => {
    const original = await tx.emailDispatch.findUnique({ where: { id } });
    if (!original || original.status === "queued" || original.status === "sending") return null;
    const created = await tx.emailDispatch.create({
      data: {
        template: original.template,
        eventKey: `resend:${original.id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        recipient: original.recipient,
        audience: original.audience,
        ...(original.orderId ? { orderId: original.orderId } : {}),
        ...(original.data !== null ? { data: original.data as Prisma.InputJsonValue } : {}),
      },
    });
    if (original.orderId) {
      await addOrderEvent(tx, original.orderId, {
        type: "email.resent",
        message: "Emailul a fost retrimis din admin",
        data: { template: original.template, dispatchId: created.id },
        actorLabel: options.actorLabel,
      });
    }
    return { newId: created.id };
  });
}
