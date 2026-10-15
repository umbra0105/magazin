import { z } from "zod";
import { type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, productCacheTags } from "./catalog-support";
import { copySkus, copyTitle } from "./product-lifecycle-rules";
import type {
  DuplicateOutcome,
  LifecycleProductRow,
  ProductLifecycleStore,
  PurgeImpact,
} from "./product-lifecycle-store";
import { MAX_BULK_PRODUCTS, parseInput } from "./product-schemas";
import type { ProductStore } from "./product-store";
import { generateUniqueSlug } from "./slug";

/**
 * Ciclul de viață al produsului: duplicare, arhivare, ștergere soft (cu restaurare) și ștergere
 * definitivă. TOATE operațiile cer `products.write` (re-verificat aici, nu doar în acțiune).
 *
 * - **Stări independente:** `status` (`draft`/`active`/`archived`) și `deletedAt` (coșul de gunoi).
 *   Ștergerea soft nu atinge `status`, deci restaurarea e „undo”; dezarhivarea duce în `draft`
 *   (nu republică în tăcere).
 * - **Selecție:** cel mult `MAX_BULK_PRODUCTS`, cu confirmare explicită și numărul așteptat;
 *   TOT SAU NIMIC, într-o singură tranzacție, cu UN singur eveniment de audit agregat.
 * - **Duplicarea** e pe un singur produs. Nu copiază niciodată prețul de achiziție, stocul, EAN-ul,
 *   identificatorii din magazinul vechi, documentele, clasa energetică/EPREL și codul producătorului.
 * - **Ștergerea definitivă** cere ca produsul să fie deja în coșul de gunoi, confirmare cu adresa lui
 *   și refuză dacă are oferte de canal active sau o referință `RESTRICT` din baza de date (comenzile,
 *   când există). Hotspot-urile fișelor explodate NU blochează: rămân în fișă, „fără produs”.
 */

const LIFECYCLE_INVALID = "CATALOG_LIFECYCLE_INVALID";

const selectionSchema = z.strictObject({
  ids: z
    .array(z.string().min(1).max(40))
    .min(1, "Alege cel puțin un produs")
    .max(MAX_BULK_PRODUCTS, `Cel mult ${MAX_BULK_PRODUCTS} produse per cerere`),
  confirm: z.literal(true, { error: "Confirmarea explicită lipsește" }),
  expectedCount: z.number().int().min(1).max(MAX_BULK_PRODUCTS),
});

const purgeSchema = z.strictObject({
  id: z.string().min(1).max(40),
  confirm: z.literal(true, { error: "Confirmarea explicită lipsește" }),
  /** Adresa produsului, tastată de administrator. */
  confirmSlug: z.string().trim().min(1).max(200),
});

export interface ProductLifecycleDeps {
  store: ProductLifecycleStore;
  /** Doar citirile de care are nevoie duplicarea (adresă, SKU, produs). */
  products: Pick<ProductStore, "findSlugOwner" | "findExistingSkus" | "getProduct">;
  audit: AuditService;
  /** Șterge fișiere din storage (documentele unui produs șters definitiv). Opțional. */
  deleteFiles?: (keys: readonly string[]) => Promise<void>;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
  now?: () => Date;
}

export interface LifecycleResult {
  count: number;
}

export interface DuplicateResult extends DuplicateOutcome {
  sourceId: string;
}

type Operation = "archive" | "unarchive" | "delete" | "restore";

interface OperationRule {
  action: string;
  eligible: { statuses?: readonly string[]; deleted: boolean };
  data: (at: Date) => { status?: string; deletedAt?: Date | null };
  /** Cum se numește în mesajul de refuz: «nu pot fi <verb>». */
  verb: string;
}

const RULES: Record<Operation, OperationRule> = {
  archive: {
    action: "product.archive",
    eligible: { statuses: ["draft", "active"], deleted: false },
    data: () => ({ status: "archived" }),
    verb: "arhivate (sunt deja arhivate sau șterse)",
  },
  unarchive: {
    action: "product.unarchive",
    eligible: { statuses: ["archived"], deleted: false },
    data: () => ({ status: "draft" }),
    verb: "dezarhivate (nu sunt arhivate sau sunt șterse)",
  },
  delete: {
    action: "product.delete",
    eligible: { deleted: false },
    data: (at) => ({ deletedAt: at }),
    verb: "șterse (sunt deja în coșul de gunoi)",
  },
  restore: {
    action: "product.restore",
    eligible: { deleted: true },
    data: () => ({ deletedAt: null }),
    verb: "restaurate (nu sunt în coșul de gunoi)",
  },
};

function isDbError(error: unknown, code: string, needle: RegExp): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (record.code === code) return true;
  if (typeof record.message === "string" && needle.test(record.message)) return true;
  return record.cause !== undefined && isDbError(record.cause, code, needle);
}

export class ProductLifecycleService {
  constructor(private readonly deps: ProductLifecycleDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async invalidate(rows: readonly { id: string; slug: string }[]): Promise<void> {
    const tags = new Set<string>([CATALOG_TAG]);
    for (const row of rows) for (const tag of productCacheTags(row)) tags.add(tag);
    try {
      await this.deps.invalidate?.([...tags]);
    } catch (error) {
      // scrierea a reușit; cache-ul expiră oricum la următoarea regenerare
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  /**
   * Copiază produsul ca ciornă. Titlul primește sufixul de copie, adresa e nouă și unică (verificată și
   * față de produsele șterse), codurile (SKU) sunt generate explicit. Un produs șters nu se copiază.
   */
  async duplicate(subject: PermissionSubject | null, productId: string): Promise<DuplicateResult> {
    assertCan(subject, "products.write");
    const source = await this.deps.products.getProduct(productId);
    if (!source) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    if (source.deletedAt) {
      throw new CatalogError(
        "CATALOG_PRODUCT_DELETED",
        "Produsul e în coșul de gunoi; restaurează-l înainte să-l duplici",
      );
    }

    const title = copyTitle(source.title);
    const slug = await generateUniqueSlug(
      title,
      async (candidate) => (await this.deps.products.findSlugOwner(candidate)) !== null,
    );
    const variants = await this.deps.store.listVariantSkus(productId);
    const skus = await copySkus(
      variants.map((v) => v.sku),
      (candidates) => this.deps.products.findExistingSkus(candidates),
    );
    const skuByVariantId = new Map(variants.map((v, i) => [v.id, skus[i] as string]));

    let outcome: DuplicateOutcome | null;
    try {
      outcome = await this.deps.store.duplicate({
        sourceId: productId,
        title,
        slug,
        skuByVariantId,
        at: this.now(),
      });
    } catch (error) {
      // altcineva a luat aceeași adresă sau același cod între verificare și scriere
      if (isDbError(error, "P2002", /unique constraint/i)) {
        throw new CatalogError(
          "CATALOG_SLUG_CONFLICT",
          "Adresa sau codurile copiei au fost luate între timp; încearcă din nou",
        );
      }
      throw error;
    }
    if (!outcome) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu mai există");

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.duplicate",
      entity: "product",
      entityId: outcome.product.id,
      after: {
        sourceId: productId,
        title: outcome.product.title,
        slug: outcome.product.slug,
        skus: outcome.variants.map((v) => v.sku),
        copied: outcome.copied,
        skipped: outcome.skipped,
      },
    });
    await this.invalidate([outcome.product]);
    return { ...outcome, sourceId: productId };
  }

  /** Arhivează produsele (activ/ciornă → arhivat). Reversibil prin `unarchive`. */
  archive(subject: PermissionSubject | null, input: unknown): Promise<LifecycleResult> {
    return this.transition(subject, "archive", input);
  }

  /** Dezarhivează produsele (arhivat → ciornă). */
  unarchive(subject: PermissionSubject | null, input: unknown): Promise<LifecycleResult> {
    return this.transition(subject, "unarchive", input);
  }

  /** Mută produsele în coșul de gunoi (ștergere soft); `status` rămâne neatins. */
  softDelete(subject: PermissionSubject | null, input: unknown): Promise<LifecycleResult> {
    return this.transition(subject, "delete", input);
  }

  /** Scoate produsele din coșul de gunoi, cu starea pe care o aveau. */
  restore(subject: PermissionSubject | null, input: unknown): Promise<LifecycleResult> {
    return this.transition(subject, "restore", input);
  }

  private async transition(
    subject: PermissionSubject | null,
    operation: Operation,
    input: unknown,
  ): Promise<LifecycleResult> {
    assertCan(subject, "products.write");
    const request = parseInput(selectionSchema, input);
    const ids = [...new Set(request.ids)];
    if (ids.length !== request.ids.length || request.expectedCount !== ids.length) {
      throw new CatalogError(
        "CATALOG_BULK_COUNT_MISMATCH",
        "Numărul de produse confirmat nu corespunde selecției; reîncarcă lista și reia",
      );
    }
    const rule = RULES[operation];

    const rows = await this.deps.store.getMany(ids);
    const eligible = rows.filter((row) => this.isEligible(row, rule));
    if (eligible.length !== ids.length) {
      throw new CatalogError(
        LIFECYCLE_INVALID,
        `${ids.length - eligible.length} din cele ${ids.length} produse selectate nu pot fi ${rule.verb}; reîncarcă lista. Nu s-a modificat nimic`,
        { selected: ids.length, eligible: eligible.length },
      );
    }

    const at = this.now();
    const updated = await this.deps.store.transition({
      ids,
      eligible: rule.eligible,
      data: rule.data(at),
    });
    if (updated !== ids.length) {
      throw new CatalogError(
        LIFECYCLE_INVALID,
        `Starea unor produse s-a schimbat între timp; reîncarcă lista. Nu s-a modificat nimic`,
        { selected: ids.length, eligible: updated },
      );
    }

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: rule.action,
      entity: "product",
      entityId: ids.length === 1 ? (ids[0] as string) : null,
      after: {
        count: ids.length,
        ids,
        ...(ids.length === 1 ? { title: rows[0]?.title, slug: rows[0]?.slug } : {}),
        ...rule.data(at),
      },
    });
    await this.invalidate(rows);
    return { count: ids.length };
  }

  private isEligible(row: LifecycleProductRow, rule: OperationRule): boolean {
    if ((row.deletedAt !== null) !== rule.eligible.deleted) return false;
    return rule.eligible.statuses ? rule.eligible.statuses.includes(row.status) : true;
  }

  /**
   * Ce s-ar întâmpla la ștergerea definitivă: ce se șterge odată cu produsul, ce rămâne (fișe,
   * hotspot-uri) și ce o blochează. Citire; cere `products.write` ca și acțiunea pe care o precede.
   */
  async describePurge(subject: PermissionSubject | null, productId: string): Promise<PurgeImpact> {
    assertCan(subject, "products.write");
    const impact = await this.deps.store.purgeImpact(productId);
    if (!impact) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    return impact;
  }

  /**
   * Șterge DEFINITIV un produs din coșul de gunoi. Refuzat dacă: nu e în coșul de gunoi, adresa
   * confirmată nu coincide, are oferte de canal active/în așteptare sau o referință `RESTRICT` din
   * baza de date (comenzi). Ireversibil: variantele, legăturile, atributele și documentele dispar.
   */
  async purge(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<{ id: string; slug: string; filesDeleted: number }> {
    assertCan(subject, "products.write");
    const request = parseInput(purgeSchema, input);
    const impact = await this.deps.store.purgeImpact(request.id);
    if (!impact) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    if (!impact.deleted) {
      throw new CatalogError(
        "CATALOG_PRODUCT_NOT_DELETED",
        "Produsul nu e în coșul de gunoi; șterge-l mai întâi, apoi poți să-l ștergi definitiv",
      );
    }
    if (request.confirmSlug.toLowerCase() !== impact.slug.toLowerCase()) {
      throw new CatalogError(
        "CATALOG_PURGE_CONFIRM_MISMATCH",
        "Adresa tastată nu coincide cu a produsului; nu s-a șters nimic",
      );
    }
    if (impact.blockingListings > 0) {
      throw new CatalogError(
        "CATALOG_PRODUCT_REFERENCED",
        `Produsul are ${impact.blockingListings} oferte active sau în așteptare pe canale de vânzare; retrage-le înainte de ștergerea definitivă`,
        { channelListings: impact.blockingListings },
      );
    }

    let outcome: { deleted: boolean; documentKeys: string[] };
    try {
      outcome = await this.deps.store.purge(request.id);
    } catch (error) {
      // plasa de siguranță: o cheie străină RESTRICT (comenzi, când există) refuză ștergerea
      if (isDbError(error, "P2003", /foreign key|restrict|violates/i)) {
        throw new CatalogError(
          "CATALOG_PRODUCT_REFERENCED",
          "Produsul e folosit în alte înregistrări (de exemplu comenzi) și nu poate fi șters definitiv; rămâne în coșul de gunoi",
        );
      }
      throw error;
    }
    if (!outcome.deleted) {
      throw new CatalogError(
        "CATALOG_PRODUCT_NOT_DELETED",
        "Produsul nu mai e în coșul de gunoi; reîncarcă lista",
      );
    }

    // după tranzacție: fișierele documentelor (un eșec lasă orfani, prinși de `docs:sweep-orphans`)
    let filesDeleted = 0;
    if (outcome.documentKeys.length > 0 && this.deps.deleteFiles) {
      try {
        await this.deps.deleteFiles(outcome.documentKeys);
        filesDeleted = outcome.documentKeys.length;
      } catch (error) {
        this.deps.logger.warn(
          { reason: error instanceof Error ? error.message : "necunoscut" },
          "catalog: fișierele documentelor nu s-au șters din storage (le prinde docs:sweep-orphans)",
        );
      }
    }

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.purge",
      entity: "product",
      entityId: impact.id,
      before: { title: impact.title, slug: impact.slug },
      after: {
        counts: impact.counts,
        diagrams: impact.diagrams.length,
        hotspotsWithoutProduct: impact.hotspots.length,
      },
    });
    await this.invalidate([impact]);
    return { id: impact.id, slug: impact.slug, filesDeleted };
  }
}
