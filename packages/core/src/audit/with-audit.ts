import { DomainError, getLogger } from "@ecom/shared";
import type { AuditService } from "./audit-service";

export interface AuditActor {
  id: string | null;
  label: string;
}

export interface AuditedActionSpec<I, O> {
  action: string;
  entity: string;
  /** Id-ul entității afectate, din input sau din rezultat (la creare id-ul apare abia în rezultat). */
  entityId?: (input: I, result: O) => string | null | undefined;
  /** Starea dinainte, citită ÎNAINTE de acțiune. Omis la creare. */
  before?: (input: I) => Promise<unknown>;
  /** Starea de după; implicit rezultatul acțiunii. Trece prin mascarea secretelor. */
  after?: (result: O, input: I) => unknown;
}

export interface AuditedActionDeps {
  audit: AuditService;
  /** Actorul curent (din sesiune). `null` = neautentificat → acțiunea nu rulează. */
  getActor: () => Promise<AuditActor | null>;
}

/**
 * Împachetează o acțiune de admin astfel încât scrierea ei să fie înregistrată în jurnal:
 *
 *   const withAudit = createWithAudit({ audit, getActor });
 *   export const saveTax = withAudit({ action: "settings.update", entity: "setting", ... }, handler);
 *
 * Ordinea: actor → `before` → acțiune → înregistrare. Dacă acțiunea aruncă, nu se scrie nimic.
 * Dacă scrierea în jurnal eșuează, eroarea `AUDIT_WRITE_FAILED` ajunge la apelant (și în loguri),
 * ca o modificare neînregistrată să nu treacă neobservată.
 */
export function createWithAudit({ audit, getActor }: AuditedActionDeps) {
  return function withAudit<I, O>(
    spec: AuditedActionSpec<I, O>,
    handler: (input: I, actor: AuditActor) => Promise<O>,
  ): (input: I) => Promise<O> {
    return async (input) => {
      const actor = await getActor();
      if (!actor) {
        throw new DomainError("AUDIT_ACTOR_REQUIRED", "Acțiunea cere un utilizator autentificat");
      }
      const before = spec.before ? await spec.before(input) : undefined;
      const result = await handler(input, actor);
      try {
        await audit.record({
          actorId: actor.id,
          actorLabel: actor.label,
          action: spec.action,
          entity: spec.entity,
          entityId: spec.entityId?.(input, result) ?? null,
          before,
          after: spec.after ? spec.after(result, input) : result,
        });
      } catch (error) {
        getLogger().error(
          { err: error, action: spec.action, entity: spec.entity },
          "scrierea în jurnalul de audit a eșuat",
        );
        throw new DomainError(
          "AUDIT_WRITE_FAILED",
          "Acțiunea a fost executată, dar nu a putut fi înregistrată în jurnalul de audit",
        );
      }
      return result;
    };
  };
}
