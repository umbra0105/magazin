import { DomainError, ForbiddenError, UnauthenticatedError, ValidationError } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { can, type PermissionSubject } from "../rbac/can";
import type { PermissionKey } from "../rbac/catalog";

/**
 * Garda pe câmpuri pentru entitățile de catalog cu structură (categorii, branduri), cu aceeași
 * regulă ca la produse (`product-write.ts`), configurată per entitate:
 *
 * - câmpuri de CONȚINUT (nume, descriere, SEO, imagine): `products.content.write` (sau `products.write`);
 * - orice alt câmp (adresă, excluderea de la discount, ...): `products.write` (deny-by-default);
 * - câmpurile din magazinul vechi (`legacyId`, `legacyUrl`): în plus `catalog.legacy.edit`
 *   (doar Admin și Owner).
 *
 * Cererea se verifică ÎNTREAGĂ înainte de aplicare; o cerere mixtă se respinge integral. Refuzul se
 * înregistrează în audit (`outcome: denied`) cu NUMELE câmpurilor, niciodată cu valorile.
 */

export interface FieldGuardConfig {
  /** Entitatea din audit și din mesaje, ex. `category`. */
  entity: string;
  /** Acțiunea din audit, ex. `category.update`. */
  action: string;
  contentFields: readonly string[];
  legacyFields: readonly string[];
  /** Nume de câmp → etichetă în română, pentru mesajul de refuz. */
  labels: Readonly<Record<string, string>>;
}

export class FieldsForbiddenError extends DomainError {
  readonly status = 403;

  constructor(
    readonly fields: readonly string[],
    readonly requiredPermissions: readonly PermissionKey[],
    labels: Readonly<Record<string, string>>,
  ) {
    super(
      "AUTH_FORBIDDEN",
      `Nu ai permisiunea să modifici: ${fields.map((f) => labels[f] ?? f).join(", ")}. Cere permisiunea ${requiredPermissions.join(" și ")}.`,
      { fields, requiredPermissions },
    );
  }
}

export class FieldAccessGuard {
  constructor(
    private readonly deps: { audit: AuditService },
    private readonly config: FieldGuardConfig,
  ) {}

  async run<T>(
    subject: PermissionSubject | null,
    target: { id: string },
    payload: Readonly<Record<string, unknown>>,
    apply: () => Promise<T>,
  ): Promise<T> {
    if (!subject) throw new UnauthenticatedError();
    const content: string[] = [];
    const restricted: string[] = [];
    const legacy: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      if (this.config.contentFields.includes(key)) content.push(key);
      else {
        restricted.push(key);
        if (this.config.legacyFields.includes(key)) legacy.push(key);
      }
    }
    if (content.length + restricted.length === 0) {
      throw new ValidationError("Nu a fost trimis niciun câmp de modificat");
    }

    const missing: PermissionKey[] = [];
    if (restricted.length > 0) {
      if (!can(subject, "products.write")) missing.push("products.write");
      if (legacy.length > 0 && !can(subject, "catalog.legacy.edit")) {
        missing.push("catalog.legacy.edit");
      }
    } else if (!can(subject, "products.content.write")) {
      missing.push("products.content.write");
    }

    if (missing.length > 0) {
      // la lipsa unei permisiuni de legacy, câmpurile refuzate sunt doar cele de legacy
      const denied =
        restricted.length === 0
          ? content
          : missing.length === 1 && missing[0] === "catalog.legacy.edit"
            ? legacy
            : restricted;
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: this.config.action,
        entity: this.config.entity,
        entityId: target.id,
        outcome: "denied",
        after: { deniedFields: denied, missingPermissions: missing },
      });
      if (restricted.length === 0) throw new ForbiddenError("products.content.write");
      throw new FieldsForbiddenError(denied, missing, this.config.labels);
    }
    return apply();
  }
}
