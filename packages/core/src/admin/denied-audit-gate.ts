import type { AuditService } from "../audit/audit-service";
import type { CounterStore } from "../auth/counter-store";
import type { DeniedAttempt } from "../rbac/can";

/**
 * Cât din refuzurile de acțiuni (server actions) intră în `audit_log`. Acțiunile sunt puncte POST publice (identificatorii
 * lor stau în bundle-ul public), iar un refuz scrie un rând într-o tabelă care nu se poate șterge: fără limită, un anonim
 * (sau orice client înregistrat) umplea jurnalul și îngropa evenimentele reale (Blocul C, C-08).
 *
 * Poarta nu schimbă răspunsul refuzului: doar decide dacă se scrie un rând.
 *  - `record`: sub plafon;
 *  - `summary`: EXACT o dată pe fereastră, la depășire (se scrie un rând-sumar, ca depășirea să lase urmă);
 *  - `skip`: restul.
 * Plafoane: pe actor (sau coș anonim) și pe adresă; fără adresă de încredere, anonimii împart un coș global cu plafon ×10.
 * Dacă depozitul de contoare nu răspunde, se înregistrează (auditul nu se pierde din cauza limitatorului).
 */

export type DeniedAuditDecision = "record" | "summary" | "skip";

export interface DeniedAuditGateOptions {
  /** Refuzuri înregistrate per actor în fereastră. */
  perActor: number;
  /** Refuzuri înregistrate per adresă în fereastră. */
  perIp: number;
  windowSeconds: number;
  /** Spațiul de nume al contoarelor. */
  namespace?: string;
}

export const DEFAULT_DENIED_AUDIT_OPTIONS: DeniedAuditGateOptions = {
  perActor: 30,
  perIp: 60,
  windowSeconds: 10 * 60,
};

/** Un anonim fără adresă de încredere nu se poate distinge de ceilalți: coș comun, cu plafon de 10 ori mai mare. */
const UNKNOWN_IP_FACTOR = 10;

export class DeniedAuditGate {
  private readonly options: DeniedAuditGateOptions;

  constructor(
    private readonly store: CounterStore,
    options: Partial<DeniedAuditGateOptions> = {},
  ) {
    this.options = { ...DEFAULT_DENIED_AUDIT_OPTIONS, ...options };
  }

  async decide(who: { actorId: string | null; ip: string | null }): Promise<DeniedAuditDecision> {
    const { perActor, perIp, windowSeconds, namespace = "denied-audit" } = this.options;
    try {
      const actorKey = who.actorId ? `${namespace}:actor:${who.actorId}` : null;
      const ipKey = who.ip ? `${namespace}:ip:${who.ip}` : `${namespace}:ip:-`;
      const ipLimit = who.ip ? perIp : perIp * UNKNOWN_IP_FACTOR;
      const [actor, ip] = await Promise.all([
        actorKey ? this.store.increment(actorKey, windowSeconds) : null,
        this.store.increment(ipKey, windowSeconds),
      ]);
      const counts: { count: number; limit: number }[] = [{ count: ip.count, limit: ipLimit }];
      if (actor) counts.push({ count: actor.count, limit: perActor });
      if (counts.some(({ count, limit }) => count === limit + 1)) return "summary";
      if (counts.some(({ count, limit }) => count > limit)) return "skip";
      return "record";
    } catch {
      return "record";
    }
  }
}

/** Rândul-sumar scris o singură dată pe fereastră când plafonul de refuzuri e depășit (urma depășirii). */
export async function recordDeniedThrottled(
  audit: AuditService,
  attempt: DeniedAttempt,
): Promise<void> {
  await audit.record({
    actorId: attempt.subject?.userId ?? null,
    actorLabel: attempt.subject?.email ?? null,
    action: "permission.denied_throttled",
    entity: "permission",
    entityId: attempt.permission,
    outcome: "denied",
    after: {
      permission: attempt.permission,
      note: "Plafonul de refuzuri înregistrate a fost depășit; în fereastra curentă refuzurile următoare nu mai sunt înscrise (se refuză în continuare).",
    },
  });
}
