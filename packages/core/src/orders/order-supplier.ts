import { inTx, type Db } from "../db-tx";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder, updateOrderAnnotations } from "./order-service";

/**
 * Marcajul «La furnizor» (Faza 11, decizia utilizatorului din 2026-11-19; punctul 7 din reconcilierea docs/06): comanda așteaptă
 * marfa de la un furnizor. NU e o stare nouă în `fulfillmentStatus`, NU modifică mașina de stări și NU atinge stocul, banii sau
 * statusurile: sunt câteva coloane pe comandă (furnizor și notă ca text liber, momentul, autorul), cu `OrderEvent` la fiecare
 * schimbare. Auditul din admin îl scrie acțiunea (`auditLog()`), nu serviciul.
 *
 * Reguli: se marchează doar comenzi active (în așteptare, confirmate, în procesare); idempotent (aceleași date = nicio schimbare
 * și niciun eveniment); scoaterea marcajului e permisă oricând (curăță și o comandă anulată între timp).
 */

export const SUPPLIER_NAME_MAX = 200;
export const SUPPLIER_NOTE_MAX = 1000;

const MARKABLE_STATUSES: readonly string[] = ["pending", "confirmed", "processing"];

export interface SupplierMarkInput {
  supplierName: string | null;
  note: string | null;
  actorLabel: string;
  now: Date;
}

function normalize(value: string | null, max: number, label: string): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new OrderError(
      "ORDER_SUPPLIER_MARK_INVALID",
      `${label} are cel mult ${max} de caractere`,
      { max },
    );
  }
  return trimmed;
}

export async function markAtSupplier(
  db: Db,
  orderId: string,
  input: SupplierMarkInput,
): Promise<{ changed: boolean }> {
  const supplierName = normalize(input.supplierName, SUPPLIER_NAME_MAX, "Numele furnizorului");
  const supplierNote = normalize(input.note, SUPPLIER_NOTE_MAX, "Nota");
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    if (!MARKABLE_STATUSES.includes(states.status)) {
      throw new OrderError(
        "ORDER_SUPPLIER_MARK_INVALID",
        "Marcajul «La furnizor» se pune doar pe comenzi active",
        { status: states.status },
      );
    }
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { supplierMarkedAt: true, supplierName: true, supplierNote: true },
    });
    const wasMarked = current.supplierMarkedAt !== null;
    if (
      wasMarked &&
      current.supplierName === supplierName &&
      current.supplierNote === supplierNote
    ) {
      return { changed: false };
    }
    await updateOrderAnnotations(tx, orderId, {
      supplierMarkedAt: wasMarked ? current.supplierMarkedAt : input.now,
      supplierMarkedBy: input.actorLabel,
      supplierName,
      supplierNote,
    });
    await addOrderEvent(tx, orderId, {
      type: wasMarked ? "order.supplier_updated" : "order.supplier_marked",
      message: wasMarked
        ? "Marcajul «La furnizor» a fost actualizat"
        : "Comanda a fost marcată «La furnizor»",
      data: { supplierName, hasNote: supplierNote !== null },
      actorLabel: input.actorLabel,
    });
    return { changed: true };
  });
}

export async function clearSupplierMark(
  db: Db,
  orderId: string,
  input: { actorLabel: string; now: Date },
): Promise<{ changed: boolean }> {
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { supplierMarkedAt: true },
    });
    if (current.supplierMarkedAt === null) return { changed: false };
    await updateOrderAnnotations(tx, orderId, {
      supplierMarkedAt: null,
      supplierMarkedBy: null,
      supplierName: null,
      supplierNote: null,
    });
    await addOrderEvent(tx, orderId, {
      type: "order.supplier_unmarked",
      message: "Marcajul «La furnizor» a fost scos",
      actorLabel: input.actorLabel,
    });
    return { changed: true };
  });
}
