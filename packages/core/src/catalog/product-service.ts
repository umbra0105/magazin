import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import {
  CATALOG_TAG,
  CatalogError,
  changedFields,
  effectivePrice,
  productCacheTags,
} from "./catalog-support";
import {
  parseInput,
  productCreateSchema,
  productUpdateSchema,
  variantUpdateSchema,
  type ProductCreateInput,
  type VariantInput,
} from "./product-schemas";
import { ProductUpdateGuard } from "./product-write";
import type {
  GeneratedVariantRow,
  ProductFieldsData,
  ProductRecord,
  ProductStore,
  VariantFieldsData,
  VariantRecord,
} from "./product-store";
import { generateUniqueSlug, isValidSlug, slugify } from "./slug";
import {
  buildSkus,
  generateCombinations,
  planVariantSync,
  type OptionInput,
} from "./variant-generator";

/**
 * Serviciul de catalog: creare și modificare de produse și variante, generare de variante.
 *
 * - **Prețul de achiziție NU trece pe aici.** Schemele sunt stricte (o cerere care îl conține e
 *   refuzată ca cheie necunoscută) și niciun `select` din `ProductStore` nu îl citește; se scrie doar
 *   prin serviciul lui dedicat (`cost-price.ts`).
 * - **Adresa (slug) e unică pe TOATE produsele, inclusiv cele șterse**, cu mesaj clar la conflict.
 * - **Permisiuni:** modificarea produsului trece prin `ProductUpdateGuard` (conținut vs. preț/stoc/...);
 *   crearea și operațiile pe variante cer `products.write`.
 * - **Audit:** fiecare scriere înregistrează diferențele (texte lungi rezumate), fără cost.
 * - **Cache:** după scriere se cheamă `invalidate(tags)`; un eșec al invalidării nu anulează scrierea.
 */

export interface ProductServiceDeps {
  store: ProductStore;
  audit: AuditService;
  /** Valoarea implicită a `manageStock` pentru produse noi (setarea `inventory.manageStock`). */
  defaultManageStock: () => Promise<boolean>;
  /** Invalidare de cache (în aplicație: `revalidateTag`). Opțional. */
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
  now?: () => Date;
}

const PRODUCT_NOT_FOUND = () => new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");

export class ProductService {
  private readonly guard: ProductUpdateGuard;

  constructor(private readonly deps: ProductServiceDeps) {
    this.guard = new ProductUpdateGuard({ audit: deps.audit });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Mesaj clar când adresa e deja folosită (de un produs activ sau de unul șters). */
  private slugConflict(
    slug: string,
    owner: { title: string; deletedAt: Date | null },
  ): CatalogError {
    const detail = owner.deletedAt
      ? `de produsul șters «${owner.title}». Restaurează-l sau alege altă adresă`
      : `de produsul «${owner.title}». Alege altă adresă`;
    return new CatalogError(
      "CATALOG_SLUG_CONFLICT",
      `Adresa «${slug}» e deja folosită ${detail}.`,
      {
        slug,
        deleted: owner.deletedAt !== null,
      },
    );
  }

  private async assertSlugFree(slug: string, excludeProductId?: string): Promise<void> {
    const owner = await this.deps.store.findSlugOwner(slug, excludeProductId);
    if (owner) throw this.slugConflict(slug, owner);
  }

  private async assertSkusFree(skus: readonly string[], excludeVariantId?: string): Promise<void> {
    const lower = skus.map((s) => s.toLowerCase());
    const dupInRequest = lower.find((s, i) => lower.indexOf(s) !== i);
    if (dupInRequest) {
      throw new CatalogError(
        "CATALOG_SKU_CONFLICT",
        `Codul «${skus[lower.indexOf(dupInRequest)]}» apare de două ori în cerere`,
      );
    }
    const taken = await this.deps.store.findExistingSkus(skus, excludeVariantId);
    if (taken.length > 0) {
      throw new CatalogError(
        "CATALOG_SKU_CONFLICT",
        `Codul ${taken.map((s) => `«${s}»`).join(", ")} e deja folosit de altă variantă`,
        { skus: taken },
      );
    }
  }

  private async invalidate(tags: readonly string[]): Promise<void> {
    try {
      await this.deps.invalidate?.(tags);
    } catch (error) {
      // scrierea a reușit; cache-ul expiră oricum la următoarea regenerare
      this.deps.logger.warn(
        { tags, reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  async getProduct(id: string): Promise<ProductRecord> {
    const product = await this.deps.store.getProduct(id);
    if (!product) throw PRODUCT_NOT_FOUND();
    return product;
  }

  /**
   * Creează un produs cu variantele lui. Fără `slug` în cerere, adresa se generează din titlu
   * (cu sufix numeric la coliziune, verificând și produsele șterse). Cere `products.write`.
   */
  async create(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<{ product: ProductRecord; variants: VariantRecord[] }> {
    assertCan(subject, "products.write");
    const data: ProductCreateInput = parseInput(productCreateSchema, input);

    const skus = data.variants.map((v) => v.sku);
    await this.assertSkusFree(skus);

    const slug =
      data.slug ??
      (await generateUniqueSlug(
        data.title,
        async (s) => (await this.deps.store.findSlugOwner(s)) !== null,
      ));
    if (data.slug) await this.assertSlugFree(data.slug);

    const { variants, ...withSlug } = data;
    const fields: Record<string, unknown> = { ...withSlug };
    delete fields["slug"];
    const at = this.now();
    const defaultIndex = variants.findIndex((v) => v.isDefault);
    const rows = variants.map((v: VariantInput, index) => {
      const rest: Record<string, unknown> = { ...v };
      delete rest["isDefault"];
      return {
        data: {
          ...(rest as unknown as VariantFieldsData),
          isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex,
        },
        effectivePrice: effectivePrice(
          {
            price: v.price,
            salePrice: v.salePrice ?? null,
            saleStartsAt: v.saleStartsAt ?? null,
            saleEndsAt: v.saleEndsAt ?? null,
          },
          at,
        ),
      };
    });

    const created = await this.deps.store.createProduct(
      {
        ...(fields as Partial<ProductFieldsData>),
        title: data.title,
        slug,
        manageStock: data.manageStock ?? (await this.deps.defaultManageStock()),
      },
      rows,
      at,
    );

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.create",
      entity: "product",
      entityId: created.product.id,
      after: {
        title: created.product.title,
        slug: created.product.slug,
        status: created.product.status,
        variants: created.variants.map((v) => v.sku),
      },
    });
    await this.invalidate(productCacheTags(created.product));
    return created;
  }

  /**
   * Modifică produsul. Trece prin `ProductUpdateGuard`: conținutul cere `products.content.write`,
   * orice alt câmp `products.write`; cererea mixtă se respinge întreagă. Validarea Zod (strictă)
   * rulează ÎNAINTE de verificarea pe câmpuri, deci o cheie necunoscută (inclusiv costul) e o eroare
   * de validare, nu o cerere care ajunge la vreun serviciu.
   */
  async update(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<ProductRecord> {
    if (!subject) throw new UnauthenticatedError();
    const patch = parseInput(productUpdateSchema, input);
    return this.guard.run(subject, { productId }, patch, async () => {
      const before = await this.deps.store.getProduct(productId);
      if (!before) throw PRODUCT_NOT_FOUND();
      if (before.deletedAt) {
        throw new CatalogError(
          "CATALOG_PRODUCT_DELETED",
          "Produsul e șters; restaurează-l înainte să-l modifici",
        );
      }
      if (patch.slug !== undefined && patch.slug.toLowerCase() !== before.slug.toLowerCase()) {
        await this.assertSlugFree(patch.slug, productId);
      }

      const diff = changedFields(before as unknown as Record<string, unknown>, patch);
      if (Object.keys(diff.after).length === 0) return before;

      const after = await this.deps.store.updateProduct(
        productId,
        patch as Partial<ProductFieldsData>,
      );
      await this.deps.audit.record({
        actorId: subject?.userId ?? null,
        actorLabel: subject?.email ?? null,
        action: "product.update",
        entity: "product",
        entityId: productId,
        before: diff.before,
        after: diff.after,
      });
      const tags = new Set([...productCacheTags(after), ...productCacheTags(before)]);
      await this.invalidate([...tags]);
      return after;
    });
  }

  /**
   * Modifică o variantă (preț, promoție, SKU, EAN, dimensiuni...). Cere `products.write`. Dacă prețul
   * EFECTIV se schimbă, îl scrie în `PriceHistory` (sursa pentru „cel mai mic preț din 30 de zile”).
   */
  async updateVariant(
    subject: PermissionSubject | null,
    variantId: string,
    input: unknown,
  ): Promise<VariantRecord> {
    assertCan(subject, "products.write");
    const patch = parseInput(variantUpdateSchema, input);
    const before = await this.deps.store.getVariant(variantId);
    if (!before) throw new CatalogError("CATALOG_VARIANT_NOT_FOUND", "Varianta nu există");

    // Verificarea promoției față de valorile combinate (existente + cerere).
    const merged = {
      price: patch.price ?? before.price,
      salePrice: patch.salePrice === undefined ? before.salePrice : patch.salePrice,
      saleStartsAt: patch.saleStartsAt === undefined ? before.saleStartsAt : patch.saleStartsAt,
      saleEndsAt: patch.saleEndsAt === undefined ? before.saleEndsAt : patch.saleEndsAt,
    };
    if (merged.salePrice !== null && merged.salePrice > merged.price) {
      throw new CatalogError(
        "CATALOG_SALE_PRICE_INVALID",
        "Prețul redus nu poate depăși prețul întreg",
      );
    }
    if (
      merged.saleStartsAt &&
      merged.saleEndsAt &&
      merged.saleStartsAt.getTime() > merged.saleEndsAt.getTime()
    ) {
      throw new CatalogError(
        "CATALOG_SALE_WINDOW_INVALID",
        "Promoția se termină înainte să înceapă",
      );
    }
    if (patch.sku !== undefined && patch.sku.toLowerCase() !== before.sku.toLowerCase()) {
      await this.assertSkusFree([patch.sku], variantId);
    }

    const diff = changedFields(before as unknown as Record<string, unknown>, patch);
    if (Object.keys(diff.after).length === 0) return before;

    const at = this.now();
    const effectiveBefore = effectivePrice(before, at);
    const effectiveAfter = effectivePrice(merged, at);
    const priceRecord = effectiveAfter !== effectiveBefore ? { price: effectiveAfter, at } : null;

    const after = await this.deps.store.updateVariant(
      variantId,
      patch as Partial<VariantFieldsData>,
      priceRecord,
    );
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.variant.update",
      entity: "product_variant",
      entityId: variantId,
      before: diff.before,
      after: diff.after,
    });
    const product = await this.deps.store.getProduct(after.productId);
    await this.invalidate(product ? productCacheTags(product) : [CATALOG_TAG]);
    return after;
  }

  /**
   * Generează variantele dintr-un set de opțiuni: adaugă doar combinațiile care lipsesc, cu SKU-uri
   * unice; variantele existente care nu mai corespund nu se șterg (se raportează). Cere `products.write`.
   */
  async generateVariants(
    subject: PermissionSubject | null,
    productId: string,
    request: { options: readonly OptionInput[]; price: number; baseSku?: string },
  ): Promise<{ created: VariantRecord[]; existing: number; orphaned: number }> {
    assertCan(subject, "products.write");
    if (!Number.isInteger(request.price) || request.price < 0) {
      throw new CatalogError(
        "CATALOG_PRICE_INVALID",
        "Prețul variantelor trebuie să fie un număr întreg de bani, ≥ 0",
      );
    }
    const product = await this.deps.store.getProduct(productId);
    if (!product) throw PRODUCT_NOT_FOUND();
    if (product.deletedAt) {
      throw new CatalogError(
        "CATALOG_PRODUCT_DELETED",
        "Produsul e șters; restaurează-l înainte să-l modifici",
      );
    }

    const combos = generateCombinations(request.options);
    const keys = await this.deps.store.listVariantCombinationKeys(productId);
    const plan = planVariantSync(combos, keys);

    let created: VariantRecord[] = [];
    if (plan.toCreate.length > 0) {
      const base =
        request.baseSku?.trim() ||
        (await this.deps.store.getDefaultSku(productId)) ||
        slugify(product.title).toUpperCase();
      // SKU-urile candidate se compară cu cele existente; la coliziune se recalculează cu sufix.
      let taken = new Set<string>();
      let skus = buildSkus(base, plan.toCreate, taken);
      for (let attempt = 0; attempt < 3; attempt++) {
        const clash = await this.deps.store.findExistingSkus(skus);
        if (clash.length === 0) break;
        taken = new Set([...taken, ...clash]);
        skus = buildSkus(base, plan.toCreate, taken);
      }
      await this.assertSkusFree(skus);

      const rows: GeneratedVariantRow[] = plan.toCreate.map((combo, i) => ({
        sku: skus[i] as string,
        price: request.price,
        selections: combo.selections,
      }));
      created = await this.deps.store.addGeneratedVariants(
        productId,
        request.options,
        rows,
        this.now(),
      );
    }

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.variants.generate",
      entity: "product",
      entityId: productId,
      after: {
        created: created.map((v) => v.sku),
        existing: plan.existing.length,
        orphaned: plan.orphaned.length,
      },
    });
    if (created.length > 0) await this.invalidate(productCacheTags(product));
    return { created, existing: plan.existing.length, orphaned: plan.orphaned.length };
  }

  /** Verifică o adresă propusă (pentru formular): liberă sau cine o folosește. */
  async checkSlug(
    subject: PermissionSubject | null,
    slug: string,
    excludeProductId?: string,
  ): Promise<{ available: boolean; message: string | null }> {
    assertCan(subject, "products.content.write");
    if (!isValidSlug(slug)) {
      return {
        available: false,
        message: "Adresa poate conține doar litere mici, cifre și cratime",
      };
    }
    const owner = await this.deps.store.findSlugOwner(slug, excludeProductId);
    return owner
      ? { available: false, message: this.slugConflict(slug, owner).message }
      : { available: true, message: null };
  }
}
