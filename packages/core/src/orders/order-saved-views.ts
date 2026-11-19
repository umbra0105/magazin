import { inTx, type Db } from "../db-tx";
import { OrderError } from "./order-errors";

/**
 * Vederile salvate ale listei de comenzi (Faza 11): proprii fiecărui utilizator (creare, redenumire, ștergere), fiecare cu un
 * nume și șirul de interogare al filtrelor. Un utilizator nu vede și nu atinge vederile altuia: orice operație pe un id se face
 * DOAR cu `userId` în condiție. Șirul de interogare nu poartă date personale (doar chei de filtru cunoscute, validate de
 * apelant); aici se verifică doar lungimea și numărul de vederi.
 */
export const VIEW_NAME_MAX = 40;
export const VIEW_QUERY_MAX = 1000;
export const VIEWS_PER_USER = 20;

export interface SavedViewDto {
  id: string;
  name: string;
  query: string;
}

function checkName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > VIEW_NAME_MAX) {
    throw new OrderError(
      "ORDER_VIEW_INVALID",
      `Numele vederii are între 1 și ${VIEW_NAME_MAX} de caractere`,
    );
  }
  return name;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

export async function listSavedViews(db: Db, userId: string): Promise<SavedViewDto[]> {
  return db.orderSavedView.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, query: true },
  });
}

export async function createSavedView(
  db: Db,
  userId: string,
  input: { name: string; query: string },
): Promise<SavedViewDto> {
  const name = checkName(input.name);
  if (input.query.length > VIEW_QUERY_MAX) {
    throw new OrderError("ORDER_VIEW_INVALID", "Filtrele vederii sunt prea lungi");
  }
  if ((await db.orderSavedView.count({ where: { userId } })) >= VIEWS_PER_USER) {
    throw new OrderError(
      "ORDER_VIEW_LIMIT",
      `Poți avea cel mult ${VIEWS_PER_USER} de vederi proprii`,
    );
  }
  try {
    return await inTx(db, (tx) =>
      tx.orderSavedView.create({
        data: { userId, name, query: input.query },
        select: { id: true, name: true, query: true },
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OrderError("ORDER_VIEW_DUPLICATE", "Ai deja o vedere cu acest nume");
    }
    throw error;
  }
}

export async function renameSavedView(
  db: Db,
  userId: string,
  id: string,
  rawName: string,
): Promise<void> {
  const name = checkName(rawName);
  let count: number;
  try {
    count = await inTx(
      db,
      async (tx) =>
        (await tx.orderSavedView.updateMany({ where: { id, userId }, data: { name } })).count,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OrderError("ORDER_VIEW_DUPLICATE", "Ai deja o vedere cu acest nume");
    }
    throw error;
  }
  if (count !== 1) throw new OrderError("ORDER_VIEW_NOT_FOUND", "Vederea nu există");
}

export async function deleteSavedView(db: Db, userId: string, id: string): Promise<void> {
  const removed = await db.orderSavedView.deleteMany({ where: { id, userId } });
  if (removed.count !== 1) throw new OrderError("ORDER_VIEW_NOT_FOUND", "Vederea nu există");
}
