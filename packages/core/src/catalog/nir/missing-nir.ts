import type { Prisma, PrismaClient } from "@ecom/db";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * «Produse fără preț NIR» (Faza 15, docs/09 §4): produsele cu cel puțin o variantă fără preț de achiziție. Un partener cumpără un
 * astfel de produs la prețul public. Condiția stă aici, în nucleul costului: lista de produse doar o aplică, ȘI doar pentru cine
 * are `products.cost.view` (altfel filtrul ar spune, produs cu produs, ce are cost și ce nu). Nu se citește nicio valoare de cost.
 */
export function missingNirWhere(): Prisma.ProductWhereInput {
  return { variants: { some: { costPrice: null } } };
}

/** Câte produse (active, în afara coșului de gunoi) nu au preț NIR pe toate variantele. */
export async function countProductsMissingNir(db: Db): Promise<number> {
  return db.product.count({
    where: { AND: [{ deletedAt: null }, { status: { not: "archived" } }, missingNirWhere()] },
  });
}
