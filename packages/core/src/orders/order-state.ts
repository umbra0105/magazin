import { DomainError } from "@ecom/shared";

/**
 * State machine-ul comenzii (docs/04 §2): trei câmpuri de status SEPARATE, cu tranziții explicite. Nicio cale din aplicație nu
 * scrie `order.status = x` direct: schimbarea trece prin `transitionOrder` (`order-service.ts`), care validează aici, scrie
 * `OrderEvent` și actualizează comanda într-o singură tranzacție (un test de arhitectură păzește asta).
 */

export const ORDER_STATUSES = [
  "draft",
  "pending",
  "confirmed",
  "processing",
  "completed",
  "cancelled",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "authorized",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
  "cancelled",
  "chargeback",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

/** draft → pending → confirmed → processing → completed; anulare din pending, confirmed, processing; completed → returned. */
export const ORDER_TRANSITIONS: Table<OrderStatus> = {
  draft: ["pending", "cancelled"],
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["completed", "cancelled"],
  completed: ["returned"],
  cancelled: [],
  returned: [],
};

/** pending → authorized | paid | failed | cancelled; authorized → paid | cancelled; paid → rambursări | chargeback. */
export const PAYMENT_TRANSITIONS: Table<PaymentStatus> = {
  pending: ["authorized", "paid", "failed", "cancelled"],
  authorized: ["paid", "cancelled"],
  paid: ["partially_refunded", "refunded", "chargeback"],
  partially_refunded: ["refunded", "chargeback"],
  refunded: [],
  failed: [],
  cancelled: [],
  chargeback: [],
};

/** unfulfilled → partially_fulfilled → fulfilled → in_transit → delivered; returned după expediere; anulare doar din unfulfilled. */
export const FULFILLMENT_TRANSITIONS: Table<FulfillmentStatus> = {
  unfulfilled: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled"],
  fulfilled: ["in_transit", "returned"],
  in_transit: ["delivered", "returned"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
};

export type StatusField = "status" | "paymentStatus" | "fulfillmentStatus";

const TABLES: Readonly<Record<StatusField, Readonly<Record<string, readonly string[]>>>> = {
  status: ORDER_TRANSITIONS,
  paymentStatus: PAYMENT_TRANSITIONS,
  fulfillmentStatus: FULFILLMENT_TRANSITIONS,
};

export function canTransition(field: StatusField, from: string, to: string): boolean {
  return TABLES[field][from]?.includes(to) ?? false;
}

export function assertTransition(field: StatusField, from: string, to: string): void {
  if (!canTransition(field, from, to)) {
    throw new DomainError(
      "ORDER_TRANSITION_INVALID",
      `Tranziția ${field}: ${from} → ${to} nu este permisă`,
      { field, from, to },
    );
  }
}
