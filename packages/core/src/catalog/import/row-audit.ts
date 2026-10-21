import { AsyncLocalStorage } from "node:async_hooks";
import { AuditService, type AuditInput, type AuditStore } from "../../audit/audit-service";

/**
 * Auditul pe entitate al unui import (Blocul C, C-12). Un import schimbă mii de produse (prețuri, stări, adrese, categorii),
 * iar serviciile catalogului pe care le cheamă își scriu deja evenimentele (`product.create`, `product.update`,
 * `category.create`…) cu `before`/`after`; înainte ele erau aruncate (audit «tăcut»), iar jurnalul păstra un singur rând
 * agregat cu numărători. Acum evenimentele se colectează cât rulează importul și se scriu în jurnalul real la sfârșit
 * (și la fiecare `flushEvery`, ca memoria să rămână mărginită), fiecare marcat cu `importId`.
 *
 * Colectarea e legată de import prin `AsyncLocalStorage`: serviciile nu știu de import, iar importurile simultane nu își
 * amestecă evenimentele. Un eveniment scris în afara unui import (fără context) nu se păstrează (serviciile acestea nu au alt
 * audit). Valorile trec prin aceeași mascare ca orice audit (câmpurile sensibile, inclusiv prețul de achiziție, devin «[ascuns]»).
 */

class CollectingAudit extends AuditService {
  constructor(private readonly onRecord: (input: AuditInput) => Promise<void>) {
    super({
      async append() {
        /* nefolosit: `record` e suprascris */
      },
      async list() {
        return [];
      },
    } satisfies AuditStore);
  }

  override async record(input: AuditInput): Promise<void> {
    await this.onRecord(input);
  }
}

export class RowAuditCollector {
  private readonly pending = new Map<string, AuditInput[]>();
  private readonly context = new AsyncLocalStorage<string>();
  /** Auditul care se dă serviciilor catalogului în locul celui «tăcut». */
  readonly audit: AuditService;

  constructor(
    private readonly sink: AuditService,
    private readonly logger: { error(obj: object, msg: string): void },
    private readonly flushEvery = 200,
  ) {
    this.audit = new CollectingAudit(async (input) => {
      const importId = this.context.getStore();
      if (!importId) return;
      const list = this.pending.get(importId) ?? [];
      list.push(input);
      this.pending.set(importId, list);
      if (list.length >= this.flushEvery) await this.flushSafely(importId);
    });
  }

  /** Rulează `fn` cu evenimentele colectate pentru `importId`; la sfârșit (și la eroare) le scrie. */
  async run<T>(importId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.context.run(importId, fn);
    } finally {
      await this.flushSafely(importId);
    }
  }

  /** Un eșec la scrierea auditului NU schimbă rezultatul importului (aplicat deja): se loghează, fără conținut. */
  private async flushSafely(importId: string): Promise<void> {
    try {
      await this.flush(importId);
    } catch (error) {
      this.logger.error(
        { importId, err: error instanceof Error ? error.message : String(error) },
        "import: evenimentele de audit pe entitate nu au putut fi scrise",
      );
    }
  }

  /** Scrie în jurnalul real evenimentele strânse pentru import, marcate cu `importId`. */
  async flush(importId: string): Promise<void> {
    const list = this.pending.get(importId);
    if (!list || list.length === 0) return;
    this.pending.delete(importId);
    await this.sink.recordMany(
      list.map((input) => ({ ...input, after: withImportId(input.after, importId) })),
    );
  }
}

function withImportId(after: unknown, importId: string): unknown {
  if (after !== null && typeof after === "object" && !Array.isArray(after)) {
    return { ...(after as Record<string, unknown>), importId };
  }
  return after === undefined || after === null ? { importId } : { value: after, importId };
}
