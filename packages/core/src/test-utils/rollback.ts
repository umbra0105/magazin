import type { getDb } from "@ecom/db";

type Db = ReturnType<typeof getDb>;
export type TestTx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

class Rollback extends Error {}

/**
 * Rulează `fn` într-o tranzacție care se anulează MEREU, ca testele de integrare să nu lase
 * nimic în baza de date (esențial pentru `audit_log`, care nu se poate șterge).
 */
export async function inRolledBackTransaction<T>(
  db: Db,
  fn: (tx: TestTx) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db
    .$transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}
