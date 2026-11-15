import type { Prisma } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "./rollback";

type Db = Parameters<typeof inRolledBackTransaction>[0];

const baselines = new WeakMap<TestTx, Set<string>>();

/**
 * Ca `inRolledBackTransaction`, dar reține rândurile de audit care existau deja la început. În baza `ecom_test` pot exista rânduri
 * de audit (imuabile) lăsate de rulările E2E; un test nu are voie să presupună o bază fără ele (CLAUDE.md, «Testele de integrare
 * nu presupun date»), deci numără doar rândurile scrise de el (`newAuditRows`). Se compară după id, nu după oră: ora rândurilor o
 * pune clientul (Prisma), iar ceasul lui poate diferi de cel al serverului Postgres.
 */
export async function inAuditScope<T>(db: Db, fn: (tx: TestTx) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    const existing = await tx.auditLog.findMany({ select: { id: true } });
    baselines.set(tx, new Set(existing.map((row) => row.id)));
    return fn(tx);
  });
}

/** Rândurile de audit potrivite cu `where`, scrise după începutul testului (în ordinea creării). */
export async function newAuditRows(tx: TestTx, where: Prisma.AuditLogWhereInput) {
  const known = baselines.get(tx);
  if (!known) throw new Error("newAuditRows se folosește doar în `inAuditScope`");
  const rows = await tx.auditLog.findMany({ where, orderBy: { createdAt: "asc" } });
  return rows.filter((row) => !known.has(row.id));
}
