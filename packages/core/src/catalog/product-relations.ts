import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, productCacheTags } from "./catalog-support";
import { PRODUCT_RELATION_TYPES, type ProductRelationType } from "./constants";
import { parseInput } from "./product-schemas";
import { ProductUpdateGuard } from "./product-write";

/**
 * Relațiile dintre produse („Asociate”). O relație e un RÂND NESIMETRIC: `productId` = produsul
 * principal, `relatedProductId` = cel asociat, cu un tip:
 *
 * | tip              | sens (principal → asociat)                                           |
 * |------------------|----------------------------------------------------------------------|
 * | `similar`        | produse asemănătoare, alternative („ți-ar mai putea plăcea”)          |
 * | `accessory`      | accesoriu al principalului (ex. husă la o pompă)                      |
 * | `upsell`         | variantă superioară, propusă în locul principalului                   |
 * | `crosssell`      | produs complementar, propus la coș                                    |
 * | `spare_part`     | asociatul e piesă de schimb a principalului                           |
 * | `compatible_with`| principalul se montează/funcționează cu asociatul                     |
 *
 * Direcția contează: „A accessory B” NU înseamnă „B accessory A”. Adminul afișează relația din
 * AMBELE părți (la A ca „ieșire”, la B ca „intrare”), iar ștergerea se poate face din oricare, fiind
 * același rând. Reguli: fără auto-relație (și CHECK în bază), fără dubluri (unic pe
 * principal+asociat+tip), produse existente și neșterse, cel mult 50 pe tip, cere `products.write`.
 */

export const MAX_RELATIONS_PER_TYPE = 50;

export interface RelatedProductSummary {
  id: string;
  title: string;
  sku: string | null;
  status: string;
  deleted: boolean;
}

export interface RelationRecord {
  id: string;
  type: ProductRelationType;
  position: number;
  /** `outgoing`: produsul curent e principalul; `incoming`: produsul curent e cel asociat. */
  direction: "outgoing" | "incoming";
  /** Celălalt produs din relație. */
  product: RelatedProductSummary;
}

export interface ProductRelationStore {
  getProduct(id: string): Promise<{ id: string; slug: string; deletedAt: Date | null } | null>;
  /** Relațiile produsului, din ambele părți. */
  list(productId: string): Promise<RelationRecord[]>;
  countOutgoing(productId: string, type: ProductRelationType): Promise<number>;
  exists(productId: string, relatedProductId: string, type: ProductRelationType): Promise<boolean>;
  create(
    productId: string,
    relatedProductId: string,
    type: ProductRelationType,
    position: number,
  ): Promise<{ id: string }>;
  find(id: string): Promise<{
    id: string;
    productId: string;
    relatedProductId: string;
    type: ProductRelationType;
  } | null>;
  delete(id: string): Promise<void>;
  /** Pozițiile relațiilor de ieșire ale tipului devin 0..n-1 în ordinea dată. */
  reorder(
    productId: string,
    type: ProductRelationType,
    orderedIds: readonly string[],
  ): Promise<void>;
}

export interface ProductRelationsDeps {
  store: ProductRelationStore;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const id = z.string().min(1).max(40);
const type = z.enum(PRODUCT_RELATION_TYPES);

const addSchema = z.strictObject({ relatedProductId: id, type });
const reorderSchema = z.strictObject({
  type,
  orderedIds: z.array(id).max(MAX_RELATIONS_PER_TYPE),
});

export class ProductRelationsService {
  private readonly guard: ProductUpdateGuard;

  constructor(private readonly deps: ProductRelationsDeps) {
    this.guard = new ProductUpdateGuard({ audit: deps.audit });
  }

  private async invalidate(tags: readonly string[]): Promise<void> {
    try {
      await this.deps.invalidate?.(tags);
    } catch (error) {
      this.deps.logger.warn(
        { tags, reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  private async liveProduct(productId: string) {
    const product = await this.deps.store.getProduct(productId);
    if (!product) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    if (product.deletedAt) {
      throw new CatalogError(
        "CATALOG_PRODUCT_DELETED",
        "Produsul e șters; restaurează-l înainte să-l modifici",
      );
    }
    return product;
  }

  /** Relațiile produsului, din ambele părți (cere `products.read`). */
  async list(subject: PermissionSubject | null, productId: string): Promise<RelationRecord[]> {
    assertCan(subject, "products.read");
    return this.deps.store.list(productId);
  }

  /** Adaugă o relație principal (`productId`) → asociat. Cere `products.write`. */
  async add(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<RelationRecord[]> {
    if (!subject) throw new UnauthenticatedError();
    const data = parseInput(addSchema, input);
    return this.guard.run(subject, { productId }, { relations: [data.type] }, async () => {
      const product = await this.liveProduct(productId);
      if (data.relatedProductId === productId) {
        throw new CatalogError(
          "CATALOG_RELATION_SELF",
          "Un produs nu poate fi asociat cu el însuși",
        );
      }
      const related = await this.liveProduct(data.relatedProductId);
      if (await this.deps.store.exists(productId, data.relatedProductId, data.type)) {
        throw new CatalogError(
          "CATALOG_RELATION_DUPLICATE",
          "Relația de acest tip între cele două produse există deja",
        );
      }
      const count = await this.deps.store.countOutgoing(productId, data.type);
      if (count >= MAX_RELATIONS_PER_TYPE) {
        throw new CatalogError(
          "CATALOG_RELATION_LIMIT",
          `Un produs poate avea cel mult ${MAX_RELATIONS_PER_TYPE} relații de același tip`,
        );
      }
      const created = await this.deps.store.create(
        productId,
        data.relatedProductId,
        data.type,
        count,
      );
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.relation.add",
        entity: "product",
        entityId: productId,
        after: { relationId: created.id, relatedProductId: data.relatedProductId, type: data.type },
      });
      await this.invalidate([
        ...productCacheTags(product),
        ...productCacheTags(related),
        CATALOG_TAG,
      ]);
      return this.deps.store.list(productId);
    });
  }

  /**
   * Șterge o relație din vederea produsului `productId` (ca principal SAU ca asociat: același rând).
   * Relația trebuie să implice acest produs.
   */
  async remove(
    subject: PermissionSubject | null,
    productId: string,
    relationId: string,
  ): Promise<RelationRecord[]> {
    if (!subject) throw new UnauthenticatedError();
    return this.guard.run(subject, { productId }, { relations: ["remove"] }, async () => {
      const product = await this.liveProduct(productId);
      const relation = await this.deps.store.find(relationId);
      if (
        !relation ||
        (relation.productId !== productId && relation.relatedProductId !== productId)
      ) {
        throw new CatalogError("CATALOG_RELATION_NOT_FOUND", "Relația nu mai există");
      }
      await this.deps.store.delete(relationId);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.relation.remove",
        entity: "product",
        entityId: productId,
        before: {
          relationId,
          productId: relation.productId,
          relatedProductId: relation.relatedProductId,
          type: relation.type,
        },
      });
      const otherId =
        relation.productId === productId ? relation.relatedProductId : relation.productId;
      const other = await this.deps.store.getProduct(otherId);
      await this.invalidate([
        ...productCacheTags(product),
        ...(other ? productCacheTags(other) : []),
        CATALOG_TAG,
      ]);
      return this.deps.store.list(productId);
    });
  }

  /** Ordinea relațiilor de ieșire ale unui tip: lista trebuie să conțină exact relațiile existente. */
  async reorder(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<RelationRecord[]> {
    if (!subject) throw new UnauthenticatedError();
    const data = parseInput(reorderSchema, input);
    return this.guard.run(subject, { productId }, { relations: [data.type] }, async () => {
      const product = await this.liveProduct(productId);
      const outgoing = (await this.deps.store.list(productId)).filter(
        (r) => r.direction === "outgoing" && r.type === data.type,
      );
      const have = outgoing.map((r) => r.id).sort();
      const want = [...data.orderedIds].sort();
      if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
        throw new CatalogError(
          "CATALOG_RELATION_MISMATCH",
          "Lista de relații s-a schimbat între timp. Reîncarcă pagina și reia",
        );
      }
      await this.deps.store.reorder(productId, data.type, data.orderedIds);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.relation.reorder",
        entity: "product",
        entityId: productId,
        after: { type: data.type, count: data.orderedIds.length },
      });
      await this.invalidate(productCacheTags(product));
      return this.deps.store.list(productId);
    });
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

const summarySelect = {
  id: true,
  title: true,
  status: true,
  deletedAt: true,
  variants: {
    orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    take: 1,
    select: { sku: true },
  },
} satisfies Prisma.ProductSelect;

type RawSummary = Prisma.ProductGetPayload<{ select: typeof summarySelect }>;

function toSummary(row: RawSummary): RelatedProductSummary {
  return {
    id: row.id,
    title: row.title,
    sku: row.variants[0]?.sku ?? null,
    status: row.status,
    deleted: row.deletedAt !== null,
  };
}

export function createPrismaProductRelationStore(db: Db): ProductRelationStore {
  return {
    getProduct: (id) =>
      db.product.findUnique({ where: { id }, select: { id: true, slug: true, deletedAt: true } }),

    async list(productId) {
      const [outgoing, incoming] = await Promise.all([
        db.productRelation.findMany({
          where: { productId },
          orderBy: [{ type: "asc" }, { position: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            type: true,
            position: true,
            relatedProduct: { select: summarySelect },
          },
        }),
        db.productRelation.findMany({
          where: { relatedProductId: productId },
          orderBy: [{ type: "asc" }, { createdAt: "asc" }],
          select: { id: true, type: true, position: true, product: { select: summarySelect } },
        }),
      ]);
      return [
        ...outgoing.map((r): RelationRecord => ({
          id: r.id,
          type: r.type as ProductRelationType,
          position: r.position,
          direction: "outgoing",
          product: toSummary(r.relatedProduct),
        })),
        ...incoming.map((r): RelationRecord => ({
          id: r.id,
          type: r.type as ProductRelationType,
          position: r.position,
          direction: "incoming",
          product: toSummary(r.product),
        })),
      ];
    },

    countOutgoing: (productId, relationType) =>
      db.productRelation.count({ where: { productId, type: relationType } }),

    async exists(productId, relatedProductId, relationType) {
      const count = await db.productRelation.count({
        where: { productId, relatedProductId, type: relationType },
      });
      return count > 0;
    },

    create: (productId, relatedProductId, relationType, position) =>
      db.productRelation.create({
        data: { productId, relatedProductId, type: relationType, position },
        select: { id: true },
      }),

    async find(relationId) {
      const row = await db.productRelation.findUnique({
        where: { id: relationId },
        select: { id: true, productId: true, relatedProductId: true, type: true },
      });
      return row ? { ...row, type: row.type as ProductRelationType } : null;
    },

    async delete(relationId) {
      await db.productRelation.delete({ where: { id: relationId } });
    },

    async reorder(productId, relationType, orderedIds) {
      await inTransaction(db, async (tx) => {
        for (const [position, relationId] of orderedIds.entries()) {
          await tx.productRelation.updateMany({
            where: { id: relationId, productId, type: relationType },
            data: { position },
          });
        }
      });
    },
  };
}
