import { getRequestContext, redactSensitive } from "@ecom/shared";

export interface AuditInput {
  actorId: string | null;
  /** Emailul sau numele actorului la momentul acțiunii (jurnalul supraviețuiește ștergerii contului). */
  actorLabel: string | null;
  /** Acțiunea, ex. `settings.update`, `product.archive`. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: Date;
}

export interface AuditFilter {
  entity?: string;
  entityId?: string;
  actorId?: string;
  limit?: number;
}

/**
 * Jurnalul e DOAR DE ADĂUGARE. Interfața e intenționat fără update/delete: nicio funcție din
 * aplicație nu poate modifica sau șterge rânduri (și triggerele din Postgres le resping oricum).
 */
export interface AuditStore {
  append(row: Omit<AuditRow, "id" | "createdAt">): Promise<void>;
  list(filter: AuditFilter): Promise<AuditRow[]>;
}

export class AuditService {
  constructor(private readonly store: AuditStore) {}

  /** Adaugă o înregistrare. `before`/`after` trec prin aceeași mascare ca loggerul. */
  async record(input: AuditInput): Promise<void> {
    await this.store.append({
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: input.before === undefined ? null : redactSensitive(input.before),
      after: input.after === undefined ? null : redactSensitive(input.after),
      requestId: getRequestContext()?.requestId ?? null,
    });
  }

  list(filter: AuditFilter = {}): Promise<AuditRow[]> {
    return this.store.list(filter);
  }
}
