import { DomainError, ForbiddenError, UnauthenticatedError, ValidationError } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { can, type PermissionSubject } from "../rbac/can";
import type { PermissionKey } from "../rbac/catalog";

/**
 * Cine are voie să modifice ce pe un produs.
 *
 * - `products.content.write` (Editor, Manager, Admin, Owner): doar `CONTENT_FIELDS`: descriere, SEO,
 *   adresă, media și documente. NU preț, stoc, cost, clasă de livrare sau TVA.
 * - `products.write` (Manager, Admin, Owner): tot restul, inclusiv conținutul (o include).
 * - costul (`costPrice`, `costPriceDate`) cere în plus `products.cost.edit` ȘI `products.cost.view`.
 *
 * Regula e DENY-BY-DEFAULT: orice câmp care nu e explicit de conținut cere `products.write`, deci un
 * câmp nou adăugat în model nu devine editabil de Editor din greșeală.
 * Verificarea e pe server; o cerere care combină câmpuri permise și interzise se respinge ÎNTREAGĂ,
 * fără aplicare parțială. Respingerea se înregistrează în audit (`outcome: denied`) cu NUMELE câmpurilor,
 * niciodată cu valorile trimise.
 */

/** Câmpurile pe care le poate modifica cineva cu doar `products.content.write`. */
export const PRODUCT_CONTENT_FIELDS = [
  "title",
  "subtitle",
  "description",
  "slug",
  "seoTitle",
  "seoDescription",
  /** Legături media ale produsului (adăugare, scoatere, reordonare). */
  "media",
  /** Documentele produsului (etichetă energetică, fișă, manual). */
  "documents",
] as const;

/** Câmpurile de cost: cer și `products.cost.edit` + `products.cost.view`. */
export const PRODUCT_COST_FIELDS = ["costPrice", "costPriceDate"] as const;

const CONTENT = new Set<string>(PRODUCT_CONTENT_FIELDS);
const COST = new Set<string>(PRODUCT_COST_FIELDS);

/** Etichete pentru mesajul de refuz (nume de câmp → text). Ce lipsește apare cu numele tehnic. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  price: "preț",
  salePrice: "preț redus",
  saleStartsAt: "începutul promoției",
  saleEndsAt: "sfârșitul promoției",
  manageStock: "gestiunea stocului",
  stockStatus: "starea stocului",
  allowBackorder: "comandă la epuizare",
  expectedRestockDate: "data reaprovizionării",
  costPrice: "preț de achiziție",
  costPriceDate: "data prețului de achiziție",
  shippingClass: "clasa de livrare",
  taxClassId: "clasa de TVA",
  variants: "variante",
  status: "starea produsului",
  brandId: "brand",
  categories: "categorii",
  excludeFromGroupDiscount: "excludere de la discountul de grup",
  measureUnitId: "unitatea de măsură",
  priceBasis: "baza prețului",
  saleStep: "pasul de vânzare",
  minSteps: "minimul comandat",
  showStepPrice: "afișarea prețului pasului",
};

export type ProductUpdatePayload = Readonly<Record<string, unknown>>;

export interface ProductUpdateClassification {
  /** Câmpuri de conținut (cer `products.content.write` sau `products.write`). */
  content: string[];
  /** Orice altceva (cere `products.write`). */
  restricted: string[];
  /** Subsetul `restricted` care e cost (cere și `products.cost.edit` + `products.cost.view`). */
  cost: string[];
}

/** Împarte cheile trimise; cheile cu valoarea `undefined` nu contează (nu au fost trimise). */
export function classifyProductUpdate(payload: ProductUpdatePayload): ProductUpdateClassification {
  const out: ProductUpdateClassification = { content: [], restricted: [], cost: [] };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (CONTENT.has(key)) out.content.push(key);
    else {
      out.restricted.push(key);
      if (COST.has(key)) out.cost.push(key);
    }
  }
  return out;
}

/**
 * Refuz pentru câmpuri la care subiectul nu are drept. Același cod stabil ca orice refuz de permisiune
 * (`AUTH_FORBIDDEN`, HTTP 403); `details.fields` are DOAR numele câmpurilor, nu valorile.
 */
export class ProductFieldsForbiddenError extends DomainError {
  readonly status = 403;

  constructor(
    readonly fields: readonly string[],
    readonly requiredPermissions: readonly PermissionKey[],
  ) {
    const labels = fields.map((f) => FIELD_LABELS[f] ?? f).join(", ");
    super(
      "AUTH_FORBIDDEN",
      `Nu ai permisiunea să modifici: ${labels}. Cere permisiunea ${requiredPermissions.join(" și ")}.`,
      { fields, requiredPermissions },
    );
  }
}

export interface ProductUpdateGuardDeps {
  audit: AuditService;
}

export class ProductUpdateGuard {
  constructor(private readonly deps: ProductUpdateGuardDeps) {}

  /**
   * Verifică ÎNTREAGA cerere, apoi (doar dacă toate câmpurile sunt permise) apelează `apply`.
   * Refuzul nu aplică nimic. `apply` primește exact cererea verificată.
   */
  async run<T>(
    subject: PermissionSubject | null,
    target: { productId: string },
    payload: ProductUpdatePayload,
    apply: (payload: ProductUpdatePayload) => Promise<T>,
  ): Promise<T> {
    if (!subject) throw new UnauthenticatedError();
    const parts = classifyProductUpdate(payload);
    if (parts.content.length + parts.restricted.length === 0) {
      throw new ValidationError("Nu a fost trimis niciun câmp de modificat");
    }

    const missing: PermissionKey[] = [];
    if (parts.restricted.length > 0) {
      if (!can(subject, "products.write")) missing.push("products.write");
      if (parts.cost.length > 0) {
        if (!can(subject, "products.cost.edit")) missing.push("products.cost.edit");
        if (!can(subject, "products.cost.view")) missing.push("products.cost.view");
      }
    } else if (!can(subject, "products.content.write")) {
      missing.push("products.content.write");
    }

    if (missing.length > 0) {
      // Câmpurile la care nu are drept: toate cele restricționate; la cerere doar de conținut, toate.
      const denied = parts.restricted.length > 0 ? parts.restricted : parts.content;
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.update",
        entity: "product",
        entityId: target.productId,
        outcome: "denied",
        // doar numele câmpurilor și permisiunile lipsă: niciodată valorile trimise
        after: { deniedFields: denied, missingPermissions: missing },
      });
      if (parts.restricted.length === 0) throw new ForbiddenError("products.content.write");
      throw new ProductFieldsForbiddenError(denied, missing);
    }
    return apply(payload);
  }
}
