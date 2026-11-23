import { inTx, type Db } from "../db-tx";
import { OrderError } from "./order-errors";
import { lockOrder, transitionOrder } from "./order-service";
import type { FulfillmentStatus } from "./order-state";

/**
 * «Marchează ridicată» pentru comenzile cu ridicare personală (Faza 14, decizia 2026-11-22): comanda nu are AWB, deci momentul
 * ridicării îl consemnează adminul. Acest moment pornește fereastra de retur (`resolveDeliveredAt`). Trece comanda prin tranzițiile
 * VALIDATE ale livrării (unfulfilled → fulfilled → in_transit → delivered), fiecare cu `OrderEvent`; pașii intermediari au tipul
 * `fulfillment.step` (fără email), iar ultimul `order.picked_up`. Idempotent: o comandă deja ridicată nu scrie al doilea eveniment.
 */
const PATH: readonly FulfillmentStatus[] = ["unfulfilled", "fulfilled", "in_transit", "delivered"];

export async function markOrderPickedUp(
  db: Db,
  orderId: string,
  actorLabel: string,
  now: Date,
): Promise<void> {
  await inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { shippingSnapshot: true },
    });
    const snapshot = order.shippingSnapshot as { kind?: unknown } | null;
    if (snapshot?.kind !== "pickup") {
      throw new OrderError(
        "ORDER_PICKUP_INVALID",
        "Doar comenzile cu ridicare personală se marchează ca ridicate",
      );
    }
    if (states.status !== "confirmed" && states.status !== "processing") {
      throw new OrderError(
        "ORDER_PICKUP_INVALID",
        "Comanda trebuie să fie confirmată ca să poată fi marcată ca ridicată",
        { status: states.status },
      );
    }
    let at = PATH.indexOf(states.fulfillmentStatus);
    if (at < 0) {
      throw new OrderError(
        "ORDER_PICKUP_INVALID",
        "Starea de livrare a comenzii nu permite ridicarea",
        {
          fulfillmentStatus: states.fulfillmentStatus,
        },
      );
    }
    if (at === PATH.length - 1) return; // deja ridicată
    while (at < PATH.length - 1) {
      const next = PATH[at + 1] as FulfillmentStatus;
      await transitionOrder(
        tx,
        orderId,
        { fulfillmentStatus: next },
        next === "delivered"
          ? { type: "order.picked_up", message: "Comanda a fost ridicată", actorLabel }
          : {
              type: "fulfillment.step",
              message: `Pregătită pentru ridicare (${next})`,
              actorLabel,
            },
        now,
      );
      at += 1;
    }
  });
}
