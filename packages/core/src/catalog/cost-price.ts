import { DomainError, ValidationError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, can, type PermissionSubject } from "../rbac/can";
import type { CostPriceSource } from "./constants";

/**
 * Prețul de achiziție (NIR, fără TVA) al unei variante: cea mai sensibilă informație din catalog.
 * Reguli, toate verificate de teste:
 *
 * - citirea cere `products.cost.view`, scrierea cere `products.cost.edit` ȘI `products.cost.view`
 *   (o combinație „poate scrie, nu poate vedea” ar fi un oracol: scrii o valoare și afli dacă a fost
 *   „aceeași”); fără `view`, răspunsurile NU conțin câmpul de cost (cheie absentă, nu `null`);
 * - jurnalul de audit și logurile înregistrează doar CĂ s-a schimbat și de cine: nicio valoare, nici
 *   veche, nici nouă; mesajele de eroare nu conțin valori;
 * - „prețul de achiziție = cel mai recent preț de intrare”: istoricul păstrează fiecare intrare, iar
 *   varianta se actualizează doar când data intrării nu e mai veche decât cea curentă;
 * - nicio suprafață publică nu atinge aceste câmpuri (testul de arhitectură
 *   `cost-exposure.architecture.test.ts`).
 */

/** Numele câmpurilor de cost de pe variantă. Orice proiecție publică le exclude. */
export const COST_FIELDS = ["costPrice", "costPriceDate"] as const;

export class CostPriceError extends DomainError {}

export function canViewCost(subject: PermissionSubject | null): boolean {
  return can(subject, "products.cost.view");
}

export interface VariantCost {
  costPrice: number | null;
  costPriceDate: Date | null;
}

export interface CostHistoryEntry {
  id: string;
  costPrice: number;
  effectiveDate: Date;
  source: string;
  createdAt: Date;
}

/**
 * Proiecția unei variante pentru admin: câmpurile de cost apar DOAR dacă subiectul are
 * `products.cost.view`; altfel cheile lipsesc cu totul (nu `null`, nu `0`).
 */
export function projectVariantForAdmin<
  T extends { costPrice?: number | null; costPriceDate?: Date | null },
>(
  subject: PermissionSubject | null,
  row: T,
): Omit<T, "costPrice" | "costPriceDate"> & Partial<VariantCost> {
  const { costPrice, costPriceDate, ...rest } = row;
  if (!canViewCost(subject)) return rest;
  return { ...rest, costPrice: costPrice ?? null, costPriceDate: costPriceDate ?? null };
}

/**
 * Lista albă a câmpurilor de variantă care pot ajunge în storefront, API public, feed-uri sau props
 * către componente client. Se adaugă câmp cu câmp; costul nu e și nu poate fi aici (test).
 */
export const PUBLIC_VARIANT_FIELDS = [
  "id",
  "productId",
  "sku",
  "ean",
  "warrantyMonths",
  "manufacturerPartNumber",
  "manufacturerName",
  "price",
  "salePrice",
  "saleStartsAt",
  "saleEndsAt",
  "weightGrams",
  "lengthMm",
  "widthMm",
  "heightMm",
  "position",
  "isDefault",
] as const;

export type PublicVariantField = (typeof PUBLIC_VARIANT_FIELDS)[number];

export function toPublicVariant<T extends Partial<Record<PublicVariantField, unknown>>>(
  row: T,
): Pick<T, Extract<PublicVariantField, keyof T>> {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_VARIANT_FIELDS) {
    if (field in row) out[field] = row[field];
  }
  return out as Pick<T, Extract<PublicVariantField, keyof T>>;
}

export interface ApplyCostCommand {
  variantId: string;
  costPrice: number;
  effectiveDate: Date;
  source: CostPriceSource;
  importId: string | null;
  /** `true`: și varianta primește valoarea (intrarea e cea mai recentă); `false`: doar istoricul. */
  updateVariant: boolean;
}

export interface CostPriceStore {
  getVariantCost(variantId: string): Promise<VariantCost | null>;
  /** Atomic: rândul din istoric și, dacă `updateVariant`, actualizarea variantei. */
  apply(command: ApplyCostCommand): Promise<void>;
  listHistory(variantId: string): Promise<CostHistoryEntry[]>;
}

export interface CostPriceDeps {
  store: CostPriceStore;
  audit: AuditService;
  logger: Pick<ReturnType<typeof getLogger>, "info">;
  now?: () => Date;
}

export interface SetCostPriceInput {
  variantId: string;
  /** În bani, fără TVA (`int`). */
  costPrice: number;
  /** Data intrării (NIR). */
  effectiveDate: Date;
  source?: CostPriceSource;
  importId?: string | null;
}

/** Marja de toleranță pentru ceasuri nesincronizate la validarea datei intrării. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export class CostPriceService {
  constructor(private readonly deps: CostPriceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Costul curent al variantei (cere `products.cost.view`). */
  async getCost(subject: PermissionSubject | null, variantId: string): Promise<VariantCost> {
    assertCan(subject, "products.cost.view");
    const current = await this.deps.store.getVariantCost(variantId);
    if (!current) throw new CostPriceError("CATALOG_VARIANT_NOT_FOUND", "Varianta nu există");
    return current;
  }

  /** Istoricul intrărilor, cele mai noi primele (cere `products.cost.view`). */
  async getHistory(
    subject: PermissionSubject | null,
    variantId: string,
  ): Promise<CostHistoryEntry[]> {
    assertCan(subject, "products.cost.view");
    return this.deps.store.listHistory(variantId);
  }

  /**
   * Înregistrează un preț de intrare. Cere `products.cost.edit` ȘI `products.cost.view`. Răspunsul NU
   * conține valori: doar dacă varianta a fost actualizată (`applied`) sau intrarea a rămas doar în
   * istoric (data mai veche decât cea curentă).
   */
  async setCost(
    subject: PermissionSubject | null,
    input: SetCostPriceInput,
  ): Promise<{ applied: boolean }> {
    assertCan(subject, "products.cost.edit");
    assertCan(subject, "products.cost.view");

    // Mesajele de validare NU repetă valorile primite.
    if (!Number.isInteger(input.costPrice) || input.costPrice < 0) {
      throw new ValidationError("Prețul de achiziție trebuie să fie un număr întreg de bani, ≥ 0");
    }
    if (Number.isNaN(input.effectiveDate.getTime())) {
      throw new ValidationError("Data intrării nu e validă");
    }
    if (input.effectiveDate.getTime() > this.now().getTime() + FUTURE_TOLERANCE_MS) {
      throw new ValidationError("Data intrării nu poate fi în viitor");
    }

    const current = await this.deps.store.getVariantCost(input.variantId);
    if (!current) throw new CostPriceError("CATALOG_VARIANT_NOT_FOUND", "Varianta nu există");

    // Cel mai recent preț de intrare: data egală înlocuiește (corecție în aceeași zi); una mai veche
    // rămâne doar în istoric. Regula strictă „doar dacă e mai nouă” a importului NIR e din Faza 15.
    // Data intrării (NIR) e o DATĂ calendaristică: se compară pe zi (UTC), nu pe ora din zi, ca o
    // corecție făcută în aceeași zi cu intrarea curentă să o înlocuiască.
    const day = (date: Date) => Math.floor(date.getTime() / 86_400_000);
    const updateVariant =
      current.costPriceDate === null || day(input.effectiveDate) >= day(current.costPriceDate);
    const source = input.source ?? "manual";

    await this.deps.store.apply({
      variantId: input.variantId,
      costPrice: input.costPrice,
      effectiveDate: input.effectiveDate,
      source,
      importId: input.importId ?? null,
      updateVariant,
    });

    // Doar faptul și autorul: nicio valoare (nici veche, nici nouă) în audit sau în loguri.
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.cost.update",
      entity: "product_variant",
      entityId: input.variantId,
      before: { hadCost: current.costPrice !== null },
      after: { changed: true, applied: updateVariant, source },
    });
    this.deps.logger.info(
      { variantId: input.variantId, applied: updateVariant, source, actorId: subject.userId },
      "catalog: prețul de achiziție a fost modificat",
    );
    return { applied: updateVariant };
  }
}
