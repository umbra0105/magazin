import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { enqueueDispatches } from "../email/dispatch";

/**
 * Emailurile returului (Faza 14): fiecare tranziție a returului produce UN email către clientul care l-a cerut, scris în outbox în
 * aceeași tranzacție cu `ReturnEvent` (unicitatea `(eventKey, șablon, destinatar)` face ca același eveniment procesat de două ori
 * să dea un singur email). Nimic nu pleacă de aici: trimiterea o face workerul, prin coadă. În outbox intră doar identificatorul
 * returului și tipul evenimentului; textul emailului se construiește la trimitere (`order-email-context.ts`) și NU conține note interne.
 */
const RULES: Readonly<Record<string, string>> = {
  "return.requested": "return.received",
  "return.approved": "return.approved",
  "return.awb_set": "return.awb",
  "return.rejected": "return.rejected",
  "return.received": "return.parcel_received",
  "return.inspected": "return.inspected",
  "return.refunded": "return.refunded",
  "return.cancelled": "return.cancelled",
};

export const RETURN_EMAIL_EVENT_TYPES: readonly string[] = Object.keys(RULES);
export const RETURN_EMAIL_TEMPLATES: readonly string[] = [...new Set(Object.values(RULES))];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function scheduleReturnEmails(
  tx: Db,
  returnId: string,
  event: { id: string; type: string },
): Promise<void> {
  const template = RULES[event.type];
  if (!template) return;
  const ret = await tx.returnRequest.findUnique({
    where: { id: returnId },
    select: {
      orderId: true,
      user: { select: { email: true, anonymizedAt: true } },
      order: { select: { externalId: true } },
    },
  });
  if (!ret || ret.user.anonymizedAt || ret.order.externalId !== null) return;
  const recipient = ret.user.email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(recipient)) return;
  const data: Prisma.InputJsonValue = { eventType: event.type, returnId };
  await enqueueDispatches(tx, [
    {
      template,
      eventKey: `return-event:${event.id}`,
      recipient,
      audience: "customer",
      orderId: ret.orderId,
      data,
    },
  ]);
}
