import { inTx, type Db } from "../db-tx";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder } from "./order-service";

/**
 * Notele interne ale comenzii (Faza 11): text liber al echipei, cu autor și moment. Doar se adaugă (nu se editează și nu se șterg
 * din aplicație). Evenimentul din timeline spune DOAR că s-a adăugat o notă (id-ul notei), nu și textul: textul poate conține
 * date personale și stă numai în `order_note`. Auditul din admin îl scrie acțiunea.
 */
export const NOTE_MAX = 2000;

export interface OrderNoteDto {
  id: string;
  authorLabel: string;
  body: string;
  createdAt: Date;
}

export async function addOrderNote(
  db: Db,
  orderId: string,
  input: { body: string; authorLabel: string },
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (body === "" || body.length > NOTE_MAX) {
    throw new OrderError("ORDER_NOTE_INVALID", `Nota are între 1 și ${NOTE_MAX} de caractere`);
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    const note = await tx.orderNote.create({
      data: { orderId, authorLabel: input.authorLabel, body },
      select: { id: true },
    });
    await addOrderEvent(tx, orderId, {
      type: "note.added",
      message: "Notă internă adăugată",
      data: { noteId: note.id },
      actorLabel: input.authorLabel,
    });
    return note;
  });
}

export async function listOrderNotes(db: Db, orderId: string): Promise<OrderNoteDto[]> {
  return db.orderNote.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, authorLabel: true, body: true, createdAt: true },
  });
}
