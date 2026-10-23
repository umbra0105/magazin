import type { AuditRow, AuditStore } from "../audit/audit-service";

/** Jurnal de audit în memorie, cu ceas propriu (createdAt) și cu o întârziere opțională la scriere. */
export class MemoryAudit implements AuditStore {
  rows: AuditRow[] = [];
  clock: () => Date = () => new Date();
  delayMs = 0;
  failNext = false;
  async append(row: Omit<AuditRow, "id" | "createdAt">): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("jurnalul de audit e indisponibil");
    }
    this.rows.push({ ...row, id: `a${this.rows.length}`, createdAt: this.clock() });
  }
  async list(filter: { entity?: string; entityId?: string; limit?: number }): Promise<AuditRow[]> {
    return this.rows
      .filter(
        (r) =>
          (!filter.entity || r.entity === filter.entity) &&
          (!filter.entityId || r.entityId === filter.entityId),
      )
      .reverse() // cele mai noi primele; ordinea scrierii departajează aceleași momente
      .slice(0, filter.limit ?? 50);
  }
  /** Rândurile unui depozit, cele mai noi primele */
  for(entityId: string, action?: string): AuditRow[] {
    return this.rows
      .filter((r) => r.entityId === entityId && (!action || r.action === action))
      .reverse();
  }
}
