import type { PrismaClient } from "@ecom/db";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";

/**
 * Jurnalul de audit pentru acțiunile de SISTEM din zona plăților (notificări, rambursări automate, reconciliere): actor «sistem»,
 * fără secrete (`AuditService` mascând oricum câmpurile sensibile). Apelat după comitere, best-effort.
 */
export function createSystemPaymentAudit(db: PrismaClient) {
  const audit = new AuditService(createPrismaAuditStore(db));
  return async (entry: {
    action: string;
    entityId: string;
    after: Record<string, unknown>;
  }): Promise<void> => {
    await audit.record({
      actorId: null,
      actorLabel: "sistem",
      action: entry.action,
      entity: "payment",
      entityId: entry.entityId,
      after: entry.after,
    });
  };
}
