import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { ReturnError } from "./return-errors";
import { scheduleReturnEmails } from "./return-emails";
import { isCustomerVisibleReturnEvent, type ReturnStatus } from "./return-constants";
import { assertReturnTransition } from "./return-state";

/**
 * Singura cale prin care se schimbă `ReturnRequest.status`: blochează rândul, validează tranziția cu state machine-ul explicit,
 * actualizează returul și scrie `ReturnEvent`, toate în tranzacția apelantului (un test de arhitectură păzește asta). Triggerul din
 * bază repetă aceleași tranziții.
 */

export interface ReturnEventInput {
  type: string;
  message: string;
  data?: Prisma.InputJsonValue;
  /** Cine a făcut acțiunea (admin); gol la acțiunile clientului sau ale sistemului. */
  actorLabel?: string;
}

export interface LockedReturn {
  status: ReturnStatus;
  orderId: string;
  userId: string;
}

/** Blochează rândul returului (`FOR UPDATE`); `null` dacă nu există. */
export async function lockReturn(tx: Db, returnId: string): Promise<LockedReturn | null> {
  const rows = await tx.$queryRaw<LockedReturn[]>`
    SELECT "status", "orderId", "userId" FROM return_request WHERE id = ${returnId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Adaugă o intrare în jurnalul returului; vizibilitatea pentru client vine din lista albă de tipuri. */
export async function addReturnEvent(
  tx: Db,
  returnId: string,
  event: ReturnEventInput,
): Promise<string> {
  const created = await tx.returnEvent.create({
    data: {
      returnId,
      type: event.type,
      message: event.message,
      visibleToCustomer: isCustomerVisibleReturnEvent(event.type),
      ...(event.data !== undefined && { data: event.data }),
      ...(event.actorLabel !== undefined && { actorLabel: event.actorLabel }),
    },
    select: { id: true },
  });
  // emailul tranziției se scrie în outbox în aceeași tranzacție (Faza 14)
  await scheduleReturnEmails(tx, returnId, { id: created.id, type: event.type });
  return created.id;
}

/** Câmpurile care însoțesc o tranziție (restul returului nu se scrie de aici). */
export interface ReturnTransitionFields {
  rejectReason?: string;
  refundId?: string;
  refundProductsMinor?: number;
}

const TIMESTAMP_FIELD: Partial<Record<ReturnStatus, string>> = {
  approved: "approvedAt",
  received: "receivedAt",
  inspected: "inspectedAt",
  refunded: "refundedAt",
  rejected: "rejectedAt",
  cancelled: "cancelledAt",
};

export async function transitionReturn(
  tx: Db,
  returnId: string,
  to: ReturnStatus,
  fields: ReturnTransitionFields,
  event: ReturnEventInput,
  now: Date,
): Promise<LockedReturn> {
  const current = await lockReturn(tx, returnId);
  if (!current) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există", { returnId });
  assertReturnTransition(current.status, to);
  const data: Prisma.ReturnRequestUpdateInput = { status: to };
  const stamp = TIMESTAMP_FIELD[to];
  if (stamp) (data as Record<string, unknown>)[stamp] = now;
  if (fields.rejectReason !== undefined) data.rejectReason = fields.rejectReason;
  if (fields.refundId !== undefined) data.refund = { connect: { id: fields.refundId } };
  if (fields.refundProductsMinor !== undefined)
    data.refundProductsMinor = fields.refundProductsMinor;
  await tx.returnRequest.update({ where: { id: returnId }, data });
  await addReturnEvent(tx, returnId, event);
  return { ...current, status: to };
}
