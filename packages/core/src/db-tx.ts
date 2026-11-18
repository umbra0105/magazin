import type { Prisma, PrismaClient } from "@ecom/db";

/** Clientul bazei sau o tranzacție deschisă. */
export type Db = PrismaClient | Prisma.TransactionClient;

const TRANSACTION = { maxWait: 15_000, timeout: 120_000 } as const;

/**
 * Rulează `fn` într-o tranzacție: pe clientul rădăcină deschide una (cu reîncercare NU: operațiile care o cer o fac singure),
 * iar pe o tranzacție deja deschisă (teste, plasarea comenzii) rulează direct în ea, ca totul să rămână atomic.
 */
export async function inTx<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) return db.$transaction(fn, TRANSACTION);
  return fn(db);
}
