import { z } from "zod";
import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, can, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, changedFields } from "./catalog-support";
import {
  MAX_CATEGORY_DEPTH,
  pathFor,
  planMove,
  planRename,
  validateMove,
  type CategoryNode,
  type MoveRefusal,
} from "./category-tree";
import type {
  CategoryRecord,
  CategoryStore,
  CategoryWithCount,
  NewCategoryData,
} from "./category-store";
import { FieldAccessGuard } from "./field-guard";
import { parseInput } from "./product-schemas";
import { generateUniqueSlug, isValidSlug, SLUG_PATTERN, SLUG_MAX_LENGTH } from "./slug";

/**
 * Categoriile: arbore cu adâncime maximă `MAX_CATEGORY_DEPTH`, adresă unică între frați, mutări validate
 * pe server (fără cicluri), ștergere refuzată cu număr de produse/subcategorii. Permisiuni: conținutul
 * (nume, descriere, SEO, imagine) cere `products.content.write`; structura (creare, mutare, adresă,
 * ștergere, excluderea de la discount) `products.write`; `legacyId`/`legacyUrl` în plus
 * `catalog.legacy.edit` (Admin, Owner).
 */

export const CATEGORY_CONTENT_FIELDS = [
  "name",
  "description",
  "seoTitle",
  "seoDescription",
  "imageMediaId",
] as const;
/**
 * «>» și «|» sunt separatoarele importului și exportului (niveluri de cale și categorii multiple într-o
 * celulă), deci nu pot apărea în numele unei categorii: o categorie cu ele n-ar putea fi reimportată.
 */
export const CATEGORY_FORBIDDEN_NAME_CHARS = /[>|]/;
export const CATEGORY_NAME_FORBIDDEN_MESSAGE =
  "Numele categoriei nu poate conține caracterele «>» și «|» (sunt separatoarele din import și export)";

export const CATEGORY_LEGACY_FIELDS = ["legacyId", "legacyUrl"] as const;

const LABELS: Readonly<Record<string, string>> = {
  slug: "adresa",
  excludeFromGroupDiscount: "excluderea de la discountul de grup",
  legacyId: "identificatorul din magazinul vechi",
  legacyUrl: "adresa din magazinul vechi",
};

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const slugField = z
  .string()
  .trim()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, "Adresa poate conține doar litere mici, cifre și cratime");

const fields = {
  name: z.string().trim().min(1, "Numele e obligatoriu").max(150),
  slug: slugField.optional(),
  description: z.string().max(20_000).nullable().optional(),
  seoTitle: text(255),
  seoDescription: text(500),
  imageMediaId: z.string().min(1).max(40).nullable().optional(),
  excludeFromGroupDiscount: z.boolean().optional(),
  legacyId: text(100),
  legacyUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/, "Adresa veche trebuie să înceapă cu http:// sau https://")
    .max(1000)
    .nullable()
    .optional(),
};

export const categoryCreateSchema = z.strictObject({
  ...fields,
  parentId: z.string().min(1).max(40).nullable().optional(),
});
export const categoryUpdateSchema = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });
export const categoryMoveSchema = z.strictObject({
  parentId: z.string().min(1).max(40).nullable(),
  index: z.number().int().min(0).max(10_000).optional(),
});

export interface CategoryServiceDeps {
  store: CategoryStore;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const REFUSAL_MESSAGES: Record<MoveRefusal, string> = {
  CATEGORY_NOT_FOUND: "Categoria nu există",
  CATEGORY_PARENT_NOT_FOUND: "Categoria părinte nu există",
  CATEGORY_SELF_PARENT: "O categorie nu poate fi propriul ei părinte",
  CATEGORY_CYCLE: "Categoria nu poate fi mutată într-una dintre propriile subcategorii",
  CATEGORY_TOO_DEEP: `Arborele de categorii poate avea cel mult ${MAX_CATEGORY_DEPTH + 1} niveluri`,
};

const asNodes = (rows: readonly CategoryRecord[]): CategoryNode[] =>
  rows.map((r) => ({
    id: r.id,
    parentId: r.parentId,
    slug: r.slug,
    name: r.name,
    path: r.path,
    depth: r.depth,
    sortOrder: r.sortOrder,
  }));

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class CategoryService {
  private readonly guard: FieldAccessGuard;

  constructor(private readonly deps: CategoryServiceDeps) {
    this.guard = new FieldAccessGuard(
      { audit: deps.audit },
      {
        entity: "category",
        action: "category.update",
        contentFields: CATEGORY_CONTENT_FIELDS,
        legacyFields: CATEGORY_LEGACY_FIELDS,
        labels: LABELS,
      },
    );
  }

  private async invalidate(ids: readonly string[]): Promise<void> {
    const tags = [CATALOG_TAG, ...ids.map((id) => `category:${id}`)];
    try {
      await this.deps.invalidate?.(tags);
    } catch (error) {
      this.deps.logger.warn(
        { tags, reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  private conflict(slug: string, owner: { name: string }): CatalogError {
    return new CatalogError(
      "CATEGORY_SLUG_CONFLICT",
      `Adresa «${slug}» e deja folosită de categoria «${owner.name}» din același loc. Alege altă adresă.`,
      { slug },
    );
  }

  private async assertImage(imageMediaId: string | null | undefined): Promise<void> {
    if (imageMediaId && !(await this.deps.store.mediaExists(imageMediaId))) {
      throw new CatalogError(
        "CATEGORY_IMAGE_NOT_FOUND",
        "Imaginea aleasă nu mai există în bibliotecă",
      );
    }
  }

  /** Arborele complet (lista plată, în ordinea afișării), cu numărul de produse. Cere `products.read`. */
  async tree(subject: PermissionSubject | null): Promise<CategoryWithCount[]> {
    assertCan(subject, "products.read");
    return this.deps.store.listAll();
  }

  /** Creează o categorie. Cere `products.write` (și `catalog.legacy.edit` dacă trimite câmpuri legacy). */
  async create(subject: PermissionSubject | null, input: unknown): Promise<CategoryRecord> {
    assertCan(subject, "products.write");
    const data = parseInput(categoryCreateSchema, input);
    if (
      (data.legacyId !== undefined || data.legacyUrl !== undefined) &&
      !can(subject, "catalog.legacy.edit")
    ) {
      assertCan(subject, "catalog.legacy.edit");
    }
    if (CATEGORY_FORBIDDEN_NAME_CHARS.test(data.name)) {
      throw new CatalogError("CATEGORY_NAME_INVALID", CATEGORY_NAME_FORBIDDEN_MESSAGE);
    }
    await this.assertImage(data.imageMediaId);

    // citire (calea și adâncimea părintelui, frații) + verificări + inserare sub blocarea arborelui: altfel o
    // mutare a părintelui sau o altă creare simultană lasă copilul cu cale veche sau cu același `sortOrder`
    const parentId = data.parentId ?? null;
    const created = await this.deps.store.serialized(async () => {
      const all = asNodes(await this.deps.store.listAll());
      const parent = parentId ? all.find((n) => n.id === parentId) : null;
      if (parentId && !parent) {
        throw new CatalogError(
          "CATEGORY_PARENT_NOT_FOUND",
          REFUSAL_MESSAGES.CATEGORY_PARENT_NOT_FOUND,
        );
      }
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > MAX_CATEGORY_DEPTH) {
        throw new CatalogError("CATEGORY_TOO_DEEP", REFUSAL_MESSAGES.CATEGORY_TOO_DEEP);
      }

      let slug: string;
      if (data.slug) {
        const owner = await this.deps.store.findSiblingBySlug(parentId, data.slug);
        if (owner) throw this.conflict(data.slug, owner);
        slug = data.slug;
      } else {
        slug = await generateUniqueSlug(
          data.name,
          async (s) => (await this.deps.store.findSiblingBySlug(parentId, s)) !== null,
        );
      }

      const siblings = all.filter((n) => n.parentId === parentId);
      const row: NewCategoryData = {
        parentId,
        slug,
        name: data.name,
        path: pathFor(parent?.path ?? null, slug),
        depth,
        sortOrder: siblings.length,
        ...(data.description !== undefined && { description: data.description }),
        ...(data.excludeFromGroupDiscount !== undefined && {
          excludeFromGroupDiscount: data.excludeFromGroupDiscount,
        }),
        ...(data.seoTitle !== undefined && { seoTitle: data.seoTitle }),
        ...(data.seoDescription !== undefined && { seoDescription: data.seoDescription }),
        ...(data.imageMediaId !== undefined && { imageMediaId: data.imageMediaId }),
        ...(data.legacyId !== undefined && { legacyId: data.legacyId }),
        ...(data.legacyUrl !== undefined && { legacyUrl: data.legacyUrl }),
      };
      return this.deps.store.create(row);
    });
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "category.create",
      entity: "category",
      entityId: created.id,
      after: { name: created.name, slug: created.slug, path: created.path, parentId },
    });
    await this.invalidate([created.id, ...(parentId ? [parentId] : [])]);
    return created;
  }

  /**
   * Modifică o categorie (fără mutare: aceea are `move`). Conținutul cere `products.content.write`,
   * restul `products.write`, `legacyId`/`legacyUrl` și `catalog.legacy.edit`; cererea mixtă se
   * respinge întreagă.
   */
  async update(
    subject: PermissionSubject | null,
    id: string,
    input: unknown,
  ): Promise<CategoryRecord> {
    if (!subject) throw new UnauthenticatedError();
    const patch = parseInput(categoryUpdateSchema, input);
    return this.guard.run(subject, { id }, patch, async () => {
      const before = await this.deps.store.get(id);
      if (!before)
        throw new CatalogError("CATEGORY_NOT_FOUND", REFUSAL_MESSAGES.CATEGORY_NOT_FOUND);
      // doar o redenumire spre un nume interzis se refuză: o categorie veche cu «>» sau «|» poate fi editată
      // în rest, iar redenumirea ei curată e permisă
      if (
        patch.name !== undefined &&
        patch.name !== before.name &&
        CATEGORY_FORBIDDEN_NAME_CHARS.test(patch.name)
      ) {
        throw new CatalogError("CATEGORY_NAME_INVALID", CATEGORY_NAME_FORBIDDEN_MESSAGE);
      }
      await this.assertImage(patch.imageMediaId);

      const slugChanged =
        patch.slug !== undefined && patch.slug.toLowerCase() !== before.slug.toLowerCase();
      if (slugChanged) {
        const owner = await this.deps.store.findSiblingBySlug(
          before.parentId,
          patch.slug as string,
          id,
        );
        if (owner) throw this.conflict(patch.slug as string, owner);
      }

      const diff = changedFields(before as unknown as Record<string, unknown>, patch);
      if (Object.keys(diff.after).length === 0) return before;

      const renamed = patch.slug !== undefined && patch.slug !== before.slug;
      if (renamed) {
        const newSlug = patch.slug as string;
        // Slug-ul și căile categoriei și ale descendenților se scriu ÎNTR-O singură tranzacție, sub blocarea arborelui
        // (C-15). Înainte, slug-ul se scria separat: un eșec între cei doi pași lăsa slug nou cu cale veche, iar două
        // redenumiri simultane puteau lăsa slug-ul uneia și calea celeilalte. Starea se citește proaspăt, sub lacăt.
        await this.deps.store.serialized(async () => {
          const nodes = asNodes(await this.deps.store.listAll());
          const node = nodes.find((n) => n.id === id);
          if (!node) {
            throw new CatalogError("CATEGORY_NOT_FOUND", REFUSAL_MESSAGES.CATEGORY_NOT_FOUND);
          }
          if (newSlug.toLowerCase() !== node.slug.toLowerCase()) {
            const owner = await this.deps.store.findSiblingBySlug(node.parentId, newSlug, id);
            if (owner) throw this.conflict(newSlug, owner);
          }
          await this.deps.store.applyUpdates(planRename(nodes, id, newSlug));
        });
      }
      // restul câmpurilor (nume, descriere, SEO…) nu sunt structurale
      const rest: Partial<typeof patch> = { ...patch };
      delete rest.slug;
      const result =
        Object.keys(rest).length > 0
          ? await this.deps.store.update(id, rest as Partial<NewCategoryData>)
          : ((await this.deps.store.get(id)) as CategoryRecord);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "category.update",
        entity: "category",
        entityId: id,
        before: diff.before,
        after: diff.after,
      });
      await this.invalidate([id, ...(before.parentId ? [before.parentId] : [])]);
      return result;
    });
  }

  /**
   * Mută o categorie sub `parentId` (`null` = rădăcină), la poziția `index` între frați. Validare pe
   * server: fără cicluri, fără propriul părinte, adâncime maximă `MAX_CATEGORY_DEPTH`, adresă unică
   * între frații noului părinte. Cere `products.write`.
   */
  async move(subject: PermissionSubject | null, id: string, input: unknown): Promise<void> {
    assertCan(subject, "products.write");
    const { parentId, index } = parseInput(categoryMoveSchema, input);
    // citire + validare + plan + scriere sub blocarea arborelui: planul scrie rândurile complete ale fraților,
    // deci o mutare simultană ar fi anulată de o citire veche
    const { node, target } = await this.deps.store.serialized(async () => {
      const rows = await this.deps.store.listAll();
      const nodes = asNodes(rows);

      const verdict = validateMove(nodes, id, parentId);
      if (!verdict.ok) throw new CatalogError(verdict.code, REFUSAL_MESSAGES[verdict.code]);

      const moved = nodes.find((n) => n.id === id) as CategoryNode;
      if (moved.parentId !== parentId) {
        const owner = await this.deps.store.findSiblingBySlug(parentId, moved.slug, id);
        if (owner) throw this.conflict(moved.slug, owner);
      }
      const position = index ?? nodes.filter((n) => n.parentId === parentId && n.id !== id).length;
      await this.deps.store.applyUpdates(planMove(nodes, id, parentId, position));
      return { node: moved, target: position };
    });

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "category.move",
      entity: "category",
      entityId: id,
      before: { parentId: node.parentId, path: node.path },
      after: { parentId, index: target },
    });
    await this.invalidate([
      ...new Set([id, node.parentId, parentId].filter((v): v is string => v !== null)),
    ]);
  }

  /**
   * Șterge o categorie goală. Refuz cu mesaj clar și numere (nu cu eroare de bază de date) dacă are
   * subcategorii sau produse. Cere `products.write`.
   */
  async delete(subject: PermissionSubject | null, id: string): Promise<void> {
    assertCan(subject, "products.write");
    const category = await this.deps.store.get(id);
    if (!category)
      throw new CatalogError("CATEGORY_NOT_FOUND", REFUSAL_MESSAGES.CATEGORY_NOT_FOUND);

    const children = await this.deps.store.countChildren(id);
    if (children > 0) {
      throw new CatalogError(
        "CATEGORY_HAS_CHILDREN",
        `Categoria «${category.name}» nu poate fi ștearsă: are ${plural(children, "subcategorie", "subcategorii")}. Mută sau șterge mai întâi subcategoriile.`,
        { children },
      );
    }
    const products = await this.deps.store.countProducts(id);
    const total = products.active + products.deleted;
    if (total > 0) {
      const parts = [plural(products.active, "produs", "produse")];
      if (products.deleted > 0)
        parts.push(`${plural(products.deleted, "produs șters", "produse șterse")}`);
      throw new CatalogError(
        "CATEGORY_HAS_PRODUCTS",
        `Categoria «${category.name}» nu poate fi ștearsă: conține ${parts.join(" și ")}. Mută produsele în altă categorie sau scoate-le din ea.`,
        { products: products.active, deletedProducts: products.deleted },
      );
    }

    await this.deps.store.delete(id);
    // frații rămași își păstrează ordinea relativă; renumerotarea nu e necesară pentru corectitudine
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "category.delete",
      entity: "category",
      entityId: id,
      before: { name: category.name, path: category.path },
    });
    await this.invalidate([id, ...(category.parentId ? [category.parentId] : [])]);
  }

  /** Verifică o adresă propusă între frații unui părinte (pentru formular). */
  async checkSlug(
    subject: PermissionSubject | null,
    slug: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<{ available: boolean; message: string | null }> {
    assertCan(subject, "products.read");
    if (!isValidSlug(slug)) {
      return {
        available: false,
        message: "Adresa poate conține doar litere mici, cifre și cratime",
      };
    }
    const owner = await this.deps.store.findSiblingBySlug(parentId, slug, excludeId);
    return owner
      ? { available: false, message: this.conflict(slug, owner).message }
      : { available: true, message: null };
  }
}
