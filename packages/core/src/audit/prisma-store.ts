import type { Prisma, PrismaClient } from "@ecom/db";
import type { AuditStore } from "./audit-service";

/** Primește doar delegatul `auditLog` și folosește DOAR `create` și `findMany` (jurnal append-only). */
export function createPrismaAuditStore(db: Pick<PrismaClient, "auditLog">): AuditStore {
  const json = (value: unknown) => (value === null ? undefined : (value as Prisma.InputJsonValue));
  return {
    async append(row) {
      await db.auditLog.create({
        data: { ...row, before: json(row.before), after: json(row.after) },
      });
    },
    async list({ entity, entityId, actorId, limit }) {
      return db.auditLog.findMany({
        where: { entity, entityId, actorId },
        orderBy: { createdAt: "desc" },
        take: Math.min(limit ?? 50, 200),
      });
    },
  };
}
