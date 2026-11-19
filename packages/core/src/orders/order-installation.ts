import { inTx, type Db } from "../db-tx";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder, updateOrderAnnotations } from "./order-service";

/**
 * Cererile de instalare (Faza 11, docs/15 §4): o comandă poate cere ofertă pentru instalare (bifa din checkout, deja salvată pe
 * comandă); aici se urmărește starea cererii, ca să nu se piardă: cerută → contactat → programată → făcută sau refuzată. Starea e
 * doar de urmărire: NU modifică totalul, stocul sau statusurile comenzii (instalarea se facturează separat). Fiecare schimbare scrie
 * `OrderEvent` (fără textul observațiilor clientului); auditul din admin îl scrie acțiunea. Ridicarea e în spatele flag-ului
 * `installationRequests` (meniul, ecranul și filtrul), dar serviciul nu depinde de el.
 */
export const INSTALLATION_STATUSES = [
  "requested",
  "contacted",
  "scheduled",
  "done",
  "declined",
] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const isInstallationStatus = (value: string): value is InstallationStatus =>
  (INSTALLATION_STATUSES as readonly string[]).includes(value);

export async function setInstallationStatus(
  db: Db,
  orderId: string,
  status: string,
  input: { actorLabel: string; now: Date },
): Promise<{ changed: boolean }> {
  if (!isInstallationStatus(status)) {
    throw new OrderError("ORDER_INSTALLATION_INVALID", "Starea cererii de instalare nu e validă");
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { installationRequested: true, installationStatus: true },
    });
    if (!order.installationRequested || order.installationStatus === null) {
      throw new OrderError("ORDER_INSTALLATION_INVALID", "Comanda nu are o cerere de instalare");
    }
    if (order.installationStatus === status) return { changed: false };
    await updateOrderAnnotations(tx, orderId, {
      installationStatus: status,
      installationStatusAt: input.now,
    });
    await addOrderEvent(tx, orderId, {
      type: "order.installation_status",
      message: "Starea cererii de instalare a fost schimbată",
      data: { from: order.installationStatus, to: status },
      actorLabel: input.actorLabel,
    });
    return { changed: true };
  });
}
