import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { scheduleOrderEmails } from "../email/order-email-triggers";
import { scheduleOrderInvoices } from "../invoicing/invoice-schedule";
import { settleReturnOnRefund } from "../returns/return-settle";
import { OrderError } from "./order-errors";
import {
  assertTransition,
  type FulfillmentStatus,
  type OrderStatus,
  type PaymentStatus,
} from "./order-state";

/**
 * Singura cale prin care se schimbă STAREA unei comenzi (`status`, `paymentStatus`, `fulfillmentStatus`): blochează rândul,
 * validează fiecare tranziție cu state machine-ul explicit, actualizează comanda și scrie `OrderEvent`, toate în tranzacția
 * apelantului. Un test de arhitectură păzește că nimic altceva nu scrie aceste câmpuri.
 */

export interface OrderStatusChange {
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: FulfillmentStatus;
}

export interface OrderEventInput {
  type: string;
  message: string;
  data?: Prisma.InputJsonValue;
  /** Cine a făcut acțiunea (admin); gol la acțiunile clientului sau ale sistemului. */
  actorLabel?: string;
}

export interface OrderStates {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
}

/** Blochează rândul comenzii (`FOR UPDATE`) și întoarce stările curente; `null` dacă nu există. */
export async function lockOrder(tx: Db, orderId: string): Promise<OrderStates | null> {
  const rows = await tx.$queryRaw<OrderStates[]>`
    SELECT "status", "paymentStatus", "fulfillmentStatus" FROM customer_order WHERE id = ${orderId} FOR UPDATE`;
  return rows[0] ?? null;
}

export async function transitionOrder(
  tx: Db,
  orderId: string,
  change: OrderStatusChange,
  event: OrderEventInput,
  now: Date,
): Promise<OrderStates> {
  const current = await lockOrder(tx, orderId);
  if (!current) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
  if (change.status !== undefined) assertTransition("status", current.status, change.status);
  if (change.paymentStatus !== undefined) {
    assertTransition("paymentStatus", current.paymentStatus, change.paymentStatus);
  }
  if (change.fulfillmentStatus !== undefined) {
    assertTransition("fulfillmentStatus", current.fulfillmentStatus, change.fulfillmentStatus);
  }
  const data: Prisma.OrderUpdateInput = {};
  if (change.status !== undefined) {
    data.status = change.status;
    if (change.status === "confirmed") data.confirmedAt = now;
    if (change.status === "cancelled") data.cancelledAt = now;
  }
  if (change.paymentStatus !== undefined) data.paymentStatus = change.paymentStatus;
  if (change.fulfillmentStatus !== undefined) data.fulfillmentStatus = change.fulfillmentStatus;
  await tx.order.update({ where: { id: orderId }, data });
  await addOrderEvent(tx, orderId, event);
  return {
    status: change.status ?? current.status,
    paymentStatus: change.paymentStatus ?? current.paymentStatus,
    fulfillmentStatus: change.fulfillmentStatus ?? current.fulfillmentStatus,
  };
}

/**
 * Mută sfârșitul rezervării curente a unei comenzi (card: la fiecare reîncercare). Nu atinge stările: ele se schimbă doar prin
 * `transitionOrder`. Apelantul ține comanda blocată.
 */
export async function setReservationExpiry(
  tx: Db,
  orderId: string,
  reservationExpiresAt: Date,
): Promise<void> {
  await tx.order.update({ where: { id: orderId }, data: { reservationExpiresAt } });
}

/**
 * Câmpurile comenzii care NU sunt stări și NU sunt bani, stoc sau linii: marcajul «La furnizor», contactul clientului și nota
 * internă. Singura cale de scriere a lor (alături de `transitionOrder` pentru stări), ca regula «un singur loc care scrie pe
 * comandă» din `orders.architecture` să rămână adevărată. Tipul nu permite statusuri, sume, linii sau rezervări.
 */
export interface OrderAnnotationFields {
  supplierMarkedAt?: Date | null;
  supplierMarkedBy?: string | null;
  supplierName?: string | null;
  supplierNote?: string | null;
  adminNote?: string | null;
  installationStatus?: string;
  installationStatusAt?: Date;
  email?: string;
  phone?: string;
}

/** Apelantul ține comanda blocată (`lockOrder`) și scrie `OrderEvent` separat. */
export async function updateOrderAnnotations(
  tx: Db,
  orderId: string,
  fields: OrderAnnotationFields,
): Promise<void> {
  await tx.order.update({ where: { id: orderId }, data: fields });
}

/** Adaugă o intrare în jurnalul comenzii (timeline); intrările nu se modifică și nu se șterg. */
export async function addOrderEvent(
  tx: Db,
  orderId: string,
  event: OrderEventInput,
): Promise<void> {
  const created = await tx.orderEvent.create({
    data: {
      orderId,
      type: event.type,
      message: event.message,
      ...(event.data !== undefined && { data: event.data }),
      ...(event.actorLabel !== undefined && { actorLabel: event.actorLabel }),
    },
  });
  // emailurile declanșate de eveniment se scriu în aceeași tranzacție (outbox); trimiterea o face workerul, prin coadă
  await scheduleOrderEmails(tx, orderId, { id: created.id, type: event.type, data: event.data });
  // documentele fiscale (proformă, factură, storno) se pun în outbox în aceeași tranzacție; le emite workerul (Faza 13)
  await scheduleOrderInvoices(tx, orderId, { id: created.id, type: event.type });
  // rambursarea unui retur, confirmată: returul se încheie și stornoul parțial se pune în coadă (Faza 14)
  await settleReturnOnRefund(tx, orderId, { type: event.type, data: event.data });
}
