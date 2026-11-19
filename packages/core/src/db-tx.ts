import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@ecom/db";

/** Clientul bazei sau o tranzacție deschisă. */
export type Db = PrismaClient | Prisma.TransactionClient;

const TRANSACTION = { maxWait: 15_000, timeout: 120_000 } as const;

/**
 * Rulează `fn` atomic: pe clientul rădăcină deschide o tranzacție; pe o tranzacție deja deschisă (teste, un apelant care are
 * deja una) folosește un SAVEPOINT, ca o eroare să anuleze doar ce a făcut `fn`, iar tranzacția apelantului să rămână utilizabilă.
 */
export async function inTx<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) return db.$transaction(fn, TRANSACTION);
  const inner = db as Prisma.TransactionClient;
  const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
  await inner.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    const result = await fn(inner);
    await inner.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await inner.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await inner.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
