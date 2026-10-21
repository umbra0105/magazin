import { getRequestContext, redactSensitive } from "@ecom/shared";

/**
 * `success` = acțiunea s-a executat; `denied` = încercare refuzată (fără permisiune, origine,
 * conținut invalid), nimic modificat; `failed` = acțiune autorizată, eșuată din cauza unei
 * defecțiuni (ex. storage indisponibil).
 */
export type AuditOutcome = "success" | "denied" | "failed";

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
  /** Implicit `success`. */
  outcome?: AuditOutcome;
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
  outcome: string;
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
  /** Opțional: mai multe rânduri într-o singură operație (importuri mari). Tot DOAR de adăugare. */
  appendMany?(rows: readonly Omit<AuditRow, "id" | "createdAt">[]): Promise<void>;
  list(filter: AuditFilter): Promise<AuditRow[]>;
}

function toRow(input: AuditInput): Omit<AuditRow, "id" | "createdAt"> {
  return {
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before === undefined ? null : redactSensitive(input.before),
    after: input.after === undefined ? null : redactSensitive(input.after),
    requestId: getRequestContext()?.requestId ?? null,
    outcome: input.outcome ?? "success",
  };
}

export class AuditService {
  constructor(private readonly store: AuditStore) {}

  /** Adaugă o înregistrare. `before`/`after` trec prin aceeași mascare ca loggerul. */
  async record(input: AuditInput): Promise<void> {
    await this.store.append(toRow(input));
  }

  /**
   * Adaugă mai multe înregistrări (aceeași mascare). Cu `appendMany` în depozit, într-o singură operație (un import de
   * mii de rânduri nu face mii de inserări separate); altfel, rând cu rând, în ordine.
   */
  async recordMany(inputs: readonly AuditInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const rows = inputs.map(toRow);
    if (this.store.appendMany) {
      await this.store.appendMany(rows);
      return;
    }
    for (const row of rows) await this.store.append(row);
  }

  list(filter: AuditFilter = {}): Promise<AuditRow[]> {
    return this.store.list(filter);
  }
}
