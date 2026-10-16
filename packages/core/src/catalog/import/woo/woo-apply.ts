import { DomainError, type getLogger } from "@ecom/shared";
import type { PermissionSubject } from "../../../rbac/can";
import type { AttributeService } from "../../attribute-service";
import type { BrandService } from "../../brand-service";
import type { CategoryService } from "../../category-service";
import type { ProductAssignmentsService } from "../../product-assignments";
import type { ProductAttributesService } from "../../product-attributes";
import type { ProductRelationsService } from "../../product-relations";
import type { ProductService } from "../../product-service";
import type { ImportPlan, PlannedRow } from "../import-plan";
import type { ProductImportStore } from "../import-store";
import type {
  WooAttributeDraft,
  WooCreateOp,
  WooOperation,
  WooRelationDraft,
  WooUpdateOp,
} from "./woo-types";

/**
 * Aplicarea unui plan WooCommerce. Ordinea:
 *  1. `prepare`: creează categoriile (părinții întâi), brandurile și atributele LIPSĂ, listate în plan
 *     (și deci văzute de administrator la verificare); rezolvă cheile la id-uri;
 *  2. `applyRow`: fiecare rând prin serviciile catalogului (cu audit tăcut): produs nou (simplu sau variabil,
 *     într-o tranzacție), actualizare, ID din magazinul vechi, valori de atribute;
 *  3. `finish`: relațiile (upsell / cross-sell), într-o a doua trecere, după ce toate produsele din fișier
 *     există; țintele nerezolvate devin avertismente pe rând.
 * O eroare pe un rând nu oprește restul; un produs variabil se aplică întreg sau deloc.
 */

export interface WooApplyDeps {
  products: Pick<ProductService, "create" | "update" | "updateVariant"> &
    Partial<Pick<ProductService, "createVariable">>;
  assignments: Pick<ProductAssignmentsService, "setCategories">;
  categories: Pick<CategoryService, "create">;
  brands: Pick<BrandService, "create">;
  attributeDefs: Pick<AttributeService, "create">;
  attributeValues: Pick<ProductAttributesService, "set">;
  relations: Pick<ProductRelationsService, "add">;
  store: Pick<ProductImportStore, "woo">;
  logger: Pick<ReturnType<typeof getLogger>, "error">;
}

export interface WooRun {
  categoryId: Map<string, string>;
  brandId: Map<string, string>;
  attributeId: Map<string, string>;
  /** Cheia → motivul pentru entitățile care nu s-au putut crea. */
  failures: Map<string, string>;
  pendingRelations: { row: number; productId: string; relations: WooRelationDraft[] }[];
  /** Rândurile produselor variabile eșuate: variațiile lor devin erori. */
  failedParents: Set<number>;
  extraWarnings: Map<number, string[]>;
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

function messageOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof DomainError || typeof code === "string"
    ? (error as Error).message
    : "Rândul nu a putut fi aplicat";
}

export class WooApplier {
  constructor(private readonly deps: WooApplyDeps) {}

  async prepare(subject: PermissionSubject, plan: ImportPlan): Promise<WooRun> {
    const woo = plan.woo;
    const run: WooRun = {
      categoryId: new Map(Object.entries(woo?.refs.categoryId ?? {})),
      brandId: new Map(Object.entries(woo?.refs.brandId ?? {})),
      attributeId: new Map(Object.entries(woo?.refs.attributeId ?? {})),
      failures: new Map(),
      pendingRelations: [],
      failedParents: new Set(),
      extraWarnings: new Map(),
    };
    if (!woo) return run;

    for (const category of woo.creations.categories) {
      const parentKey = category.key.includes(">")
        ? category.key.slice(0, category.key.lastIndexOf(">"))
        : null;
      if (parentKey !== null && !run.categoryId.has(parentKey)) {
        run.failures.set(`category:${category.key}`, "categoria părinte nu s-a putut crea");
        continue;
      }
      try {
        const created = await this.deps.categories.create(subject, {
          name: category.names[category.names.length - 1],
          parentId: parentKey === null ? null : (run.categoryId.get(parentKey) ?? null),
        });
        run.categoryId.set(category.key, created.id);
      } catch (error) {
        run.failures.set(`category:${category.key}`, messageOf(error));
      }
    }
    for (const brand of woo.creations.brands) {
      try {
        const created = await this.deps.brands.create(subject, { name: brand.name });
        run.brandId.set(brand.key, created.id);
      } catch (error) {
        run.failures.set(`brand:${brand.key}`, messageOf(error));
      }
    }
    for (const attribute of woo.creations.attributes) {
      try {
        const created = await this.deps.attributeDefs.create(subject, {
          code: attribute.code,
          name: attribute.name,
          type: "text",
        });
        run.attributeId.set(attribute.key, created.id);
      } catch (error) {
        run.failures.set(`attribute:${attribute.key}`, messageOf(error));
      }
    }
    return run;
  }

  private brandOf(run: WooRun, key: string | null | undefined): string | null | undefined {
    if (key === undefined || key === null) return key;
    const id = run.brandId.get(key);
    if (id) return id;
    throw new DomainError(
      "IMPORT_WOO_DEPENDENCY",
      `Brandul nu a putut fi creat: ${run.failures.get(`brand:${key}`) ?? "necunoscut"}`,
    );
  }

  private categoriesOf(run: WooRun, keys: readonly string[]): string[] {
    return keys.map((key) => {
      const id = run.categoryId.get(key);
      if (id) return id;
      throw new DomainError(
        "IMPORT_WOO_DEPENDENCY",
        `Categoria nu a putut fi creată: ${run.failures.get(`category:${key}`) ?? "necunoscut"}`,
      );
    });
  }

  /** Valorile de atribute cu id-uri; atributele care n-au putut fi create devin avertismente. */
  private attributeValuesOf(
    run: WooRun,
    row: number,
    drafts: readonly WooAttributeDraft[],
  ): { attributeId: string; value: string | boolean }[] {
    const out: { attributeId: string; value: string | boolean }[] = [];
    for (const draft of drafts) {
      const id = run.attributeId.get(draft.key);
      if (id) out.push({ attributeId: id, value: draft.value });
      else {
        this.warn(
          run,
          row,
          `Atribut neaplicat: ${run.failures.get(`attribute:${draft.key}`) ?? "atributul nu există"}`,
        );
      }
    }
    return out;
  }

  private warn(run: WooRun, row: number, text: string): void {
    run.extraWarnings.set(row, [...(run.extraWarnings.get(row) ?? []), text]);
  }

  async applyRow(subject: PermissionSubject, row: PlannedRow, run: WooRun): Promise<PlannedRow> {
    const op = row.op as WooOperation | null;
    if (!op) return row;
    try {
      if (op.kind === "woo-child") {
        if (run.failedParents.has(op.parentRow)) {
          return {
            ...row,
            outcome: "error",
            op: null,
            messages: [
              ...row.messages,
              {
                level: "error",
                text: `Neaplicat: produsul variabil de la rândul ${op.parentRow} nu s-a creat`,
              },
            ],
          };
        }
        return row;
      }
      if (op.kind === "woo-create") await this.create(subject, row, op, run);
      else await this.update(subject, row, op, run);
      return this.withWarnings(row, run);
    } catch (error) {
      if (op.kind === "woo-create") run.failedParents.add(row.row);
      const code = (error as { code?: unknown } | null)?.code;
      if (!(error instanceof DomainError) && typeof code !== "string") {
        this.deps.logger.error(
          { row: row.row },
          "import WooCommerce: rând neaplicat din cauza unei erori neașteptate",
        );
      }
      return this.failed(row, messageOf(error));
    }
  }

  private failed(row: PlannedRow, message: string): PlannedRow {
    return {
      ...row,
      outcome: "error",
      op: null,
      messages: [...row.messages, { level: "error", text: `Neaplicat: ${message}` }],
    };
  }

  private withWarnings(row: PlannedRow, run: WooRun): PlannedRow {
    const extra = run.extraWarnings.get(row.row);
    if (!extra || extra.length === 0) return row;
    return {
      ...row,
      messages: [...row.messages, ...extra.map((text) => ({ level: "warning" as const, text }))],
    };
  }

  private async create(
    subject: PermissionSubject,
    row: PlannedRow,
    op: WooCreateOp,
    run: WooRun,
  ): Promise<void> {
    const brandId = this.brandOf(run, op.product.brandKey);
    const categoryIds = this.categoriesOf(run, op.product.categoryKeys);
    const input = {
      title: op.product.title,
      subtitle: op.product.subtitle,
      description: op.product.description,
      // produsul se creează ciornă; o stare «activ» se aplică după, ca regulile de activare să ruleze
      status: "draft",
      shippingClass: op.product.shippingClass,
      ...(brandId ? { brandId } : {}),
      categoryIds,
      variants: op.variants.map((v, index) => ({
        sku: v.sku,
        price: v.price,
        salePrice: v.salePrice,
        saleStartsAt: v.saleStartsAt,
        saleEndsAt: v.saleEndsAt,
        ean: v.ean,
        weightGrams: v.weightGrams,
        lengthMm: v.lengthMm,
        widthMm: v.widthMm,
        heightMm: v.heightMm,
        isDefault: index === 0,
      })),
    };
    let created;
    if (op.options.length > 0) {
      if (!this.deps.products.createVariable) {
        throw new DomainError("IMPORT_WOO_UNAVAILABLE", "Produsele variabile nu sunt disponibile");
      }
      const selections = new Map(op.variants.map((v) => [v.sku, v.selections]));
      created = await this.deps.products.createVariable(subject, input, op.options, selections);
    } else {
      created = await this.deps.products.create(subject, input);
    }
    const productId = created.product.id;
    if (op.product.status === "active") {
      await this.deps.products.update(subject, productId, { status: "active" });
    }
    if (op.legacyId) {
      const saved = await this.deps.store.woo.setProductLegacyId(productId, op.legacyId);
      if (!saved)
        this.warn(
          run,
          row.row,
          "ID din magazinul vechi: e deja folosit de alt produs; nu s-a salvat",
        );
    }
    for (const draft of op.variants) {
      if (!draft.legacyId) continue;
      const variant = created.variants.find((v) => v.sku === draft.sku);
      if (variant && !(await this.deps.store.woo.setVariantLegacyId(variant.id, draft.legacyId))) {
        this.warn(
          run,
          row.row,
          `ID din magazinul vechi al variantei ${draft.sku} e deja folosit; nu s-a salvat`,
        );
      }
    }
    await this.setAttributes(subject, row.row, productId, op.attributeValues, run);
    if (op.relations.length > 0)
      run.pendingRelations.push({ row: row.row, productId, relations: op.relations });
  }

  private async update(
    subject: PermissionSubject,
    row: PlannedRow,
    op: WooUpdateOp,
    run: WooRun,
  ): Promise<void> {
    if (op.variantPatch && op.variantId) {
      await this.deps.products.updateVariant(subject, op.variantId, op.variantPatch);
    }
    const patch = op.productPatch ? { ...op.productPatch } : {};
    if (op.brandKey !== undefined) {
      const brandId = this.brandOf(run, op.brandKey);
      if (brandId !== undefined) asRecord(patch)["brandId"] = brandId;
    }
    if (Object.keys(patch).length > 0)
      await this.deps.products.update(subject, op.productId, patch);
    if (op.categoryKeys) {
      await this.deps.assignments.setCategories(subject, op.productId, {
        categoryIds: this.categoriesOf(run, op.categoryKeys),
      });
    }
    if (op.legacyProduct) {
      const saved = await this.deps.store.woo.setProductLegacyId(op.productId, op.legacyProduct);
      if (!saved)
        this.warn(
          run,
          row.row,
          "ID din magazinul vechi: e deja folosit de alt produs; nu s-a salvat",
        );
    }
    if (op.legacyVariant && op.variantId) {
      const saved = await this.deps.store.woo.setVariantLegacyId(op.variantId, op.legacyVariant);
      if (!saved)
        this.warn(
          run,
          row.row,
          "ID din magazinul vechi al variantei e deja folosit; nu s-a salvat",
        );
    }
    await this.setAttributes(subject, row.row, op.productId, op.attributeValues, run);
    if (op.relations.length > 0) {
      run.pendingRelations.push({ row: row.row, productId: op.productId, relations: op.relations });
    }
  }

  private async setAttributes(
    subject: PermissionSubject,
    row: number,
    productId: string,
    drafts: readonly WooAttributeDraft[],
    run: WooRun,
  ): Promise<void> {
    const values = this.attributeValuesOf(run, row, drafts);
    if (values.length === 0) return;
    try {
      await this.deps.attributeValues.set(subject, productId, { values });
    } catch (error) {
      this.warn(run, row, `Atribute neaplicate: ${messageOf(error)}`);
    }
  }

  /** Relațiile, după ce toate produsele din fișier există. Întoarce avertismentele pe rând. */
  async finish(subject: PermissionSubject, run: WooRun): Promise<Map<number, string[]>> {
    if (run.pendingRelations.length === 0) return run.extraWarnings;
    const skus = new Set<string>();
    const legacyIds = new Set<string>();
    for (const pending of run.pendingRelations) {
      for (const relation of pending.relations) {
        if ("sku" in relation.target) skus.add(relation.target.sku);
        else legacyIds.add(relation.target.legacyId);
      }
    }
    const bySku = await this.deps.store.woo.findProductIdsBySku([...skus]);
    const byLegacy = await this.deps.store.woo.findProductIdsByLegacyId([...legacyIds]);
    for (const pending of run.pendingRelations) {
      for (const relation of pending.relations) {
        const targetId =
          "sku" in relation.target
            ? bySku.get(relation.target.sku.toLowerCase())
            : byLegacy.get(relation.target.legacyId);
        if (!targetId) {
          this.warn(
            run,
            pending.row,
            "Relație nerezolvată: produsul țintă nu există în catalog; se omite",
          );
          continue;
        }
        if (targetId === pending.productId) continue;
        try {
          await this.deps.relations.add(subject, pending.productId, {
            relatedProductId: targetId,
            type: relation.type,
          });
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === "CATALOG_RELATION_DUPLICATE") continue;
          this.warn(run, pending.row, `Relație neaplicată: ${messageOf(error)}`);
        }
      }
    }
    return run.extraWarnings;
  }
}
