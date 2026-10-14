import type { Prisma, PrismaClient } from "@ecom/db";
import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { StorageDriver } from "@ecom/integrations";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, productCacheTags } from "./catalog-support";
import { pickThumbUrl } from "./product-list";
import { parseInput, productCategoriesSchema, productMediaSchema } from "./product-schemas";
import { ProductUpdateGuard } from "./product-write";

/**
 * Categoriile și imaginile unui produs (tab-urile Categorii și Media ale editorului).
 *
 * - **Permisiuni:** categoriile cer `products.write` (cheia `categories` e „restricționată” în
 *   `ProductUpdateGuard`), media cere `products.content.write` (cheia `media` e de conținut). Aceeași
 *   poartă ca la restul câmpurilor: deny-by-default, refuzul se înregistrează în audit cu numele
 *   câmpului, fără valori.
 * - **Media:** doar fișiere `ready` din bibliotecă; legăturile la nivel de VARIANTĂ nu se ating
 *   (le gestionează tabul Variante). Prima din listă e imaginea principală.
 * - Audit: id-urile înainte și după (nu sunt sensibile); nicio scriere dacă nu s-a schimbat nimic.
 */

export interface AssignedCategory {
  categoryId: string;
  isPrimary: boolean;
}

export interface ProductMediaItem {
  /** Id-ul legăturii produs ↔ fișier. */
  id: string;
  mediaId: string;
  position: number;
  name: string;
  alt: string;
  status: string;
  /** Adresa variantei `thumb`, sau `null` dacă fișierul nu e gata. Niciodată originalul. */
  thumb: string | null;
}

interface RawProductMedia {
  id: string;
  mediaId: string;
  position: number;
  media: {
    originalName: string;
    alt: string | null;
    status: string;
    storageKey: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    variants: unknown;
  };
}

export interface ProductAssignmentStore {
  getProduct(id: string): Promise<{ id: string; slug: string; deletedAt: Date | null } | null>;
  listCategories(productId: string): Promise<AssignedCategory[]>;
  /** Dintre `ids`, cele care există. */
  existingCategoryIds(ids: readonly string[]): Promise<string[]>;
  /** ATOMIC: înlocuiește categoriile produsului. */
  replaceCategories(productId: string, rows: readonly AssignedCategory[]): Promise<void>;
  /** Legăturile media la nivel de produs (fără cele ale variantelor), în ordine. */
  listMedia(productId: string): Promise<RawProductMedia[]>;
  /** Dintre `ids`, fișierele care există ȘI sunt gata (`ready`). */
  readyMediaIds(ids: readonly string[]): Promise<string[]>;
  /** ATOMIC: înlocuiește legăturile media la nivel de produs, în ordinea dată. */
  replaceMedia(productId: string, mediaIds: readonly string[]): Promise<void>;
}

export interface ProductAssignmentDeps {
  store: ProductAssignmentStore;
  audit: AuditService;
  storage: StorageDriver;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const NOT_FOUND = () => new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");

export class ProductAssignmentsService {
  private readonly guard: ProductUpdateGuard;

  constructor(private readonly deps: ProductAssignmentDeps) {
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
    if (!product) throw NOT_FOUND();
    if (product.deletedAt) {
      throw new CatalogError(
        "CATALOG_PRODUCT_DELETED",
        "Produsul e șters; restaurează-l înainte să-l modifici",
      );
    }
    return product;
  }

  /** Categoriile produsului (cere `products.read`). */
  async getCategories(
    subject: PermissionSubject | null,
    productId: string,
  ): Promise<AssignedCategory[]> {
    assertCan(subject, "products.read");
    return this.deps.store.listCategories(productId);
  }

  /**
   * Înlocuiește categoriile produsului. `primaryId` lipsă = prima din listă. Cere `products.write`
   * (prin poarta de câmpuri). Listă goală = produs fără categorie.
   */
  async setCategories(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<AssignedCategory[]> {
    if (!subject) throw new UnauthenticatedError();
    const data = parseInput(productCategoriesSchema, input);
    return this.guard.run(subject, { productId }, { categories: data.categoryIds }, async () => {
      const product = await this.liveProduct(productId);
      const found = await this.deps.store.existingCategoryIds(data.categoryIds);
      if (found.length !== data.categoryIds.length) {
        throw new CatalogError("CATEGORY_NOT_FOUND", "O categorie aleasă nu mai există");
      }
      const primaryId = data.primaryId ?? data.categoryIds[0] ?? null;
      const rows = data.categoryIds.map((categoryId) => ({
        categoryId,
        isPrimary: categoryId === primaryId,
      }));

      const before = await this.deps.store.listCategories(productId);
      const key = (list: readonly AssignedCategory[]) =>
        [...list]
          .map((c) => `${c.categoryId}:${c.isPrimary ? 1 : 0}`)
          .sort()
          .join("|");
      if (key(before) === key(rows)) return before;

      await this.deps.store.replaceCategories(productId, rows);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.categories.update",
        entity: "product",
        entityId: productId,
        before: {
          categoryIds: before.map((c) => c.categoryId),
          primaryId: before.find((c) => c.isPrimary)?.categoryId ?? null,
        },
        after: { categoryIds: data.categoryIds, primaryId },
      });
      await this.invalidate([...productCacheTags(product), CATALOG_TAG]);
      return rows;
    });
  }

  /** Imaginile produsului, în ordinea afișării, cu `thumb` (cere `products.read`). */
  async listMedia(
    subject: PermissionSubject | null,
    productId: string,
  ): Promise<ProductMediaItem[]> {
    assertCan(subject, "products.read");
    const rows = await this.deps.store.listMedia(productId);
    return rows.map((row) => ({
      id: row.id,
      mediaId: row.mediaId,
      position: row.position,
      name: row.media.originalName,
      alt: row.media.alt ?? "",
      status: row.media.status,
      thumb: row.media.status === "ready" ? pickThumbUrl(row.media, this.deps.storage) : null,
    }));
  }

  /**
   * Înlocuiește imaginile produsului cu lista dată, în ordine (prima = principală). Cere
   * `products.content.write`. Doar fișiere din bibliotecă în starea `ready`.
   */
  async setMedia(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<{ mediaIds: string[] }> {
    if (!subject) throw new UnauthenticatedError();
    const data = parseInput(productMediaSchema, input);
    return this.guard.run(subject, { productId }, { media: data.mediaIds }, async () => {
      const product = await this.liveProduct(productId);
      const ready = new Set(await this.deps.store.readyMediaIds(data.mediaIds));
      const invalid = data.mediaIds.filter((id) => !ready.has(id));
      if (invalid.length > 0) {
        throw new CatalogError(
          "CATALOG_MEDIA_INVALID",
          `${invalid.length} dintre fișierele alese nu există sau nu sunt gata de folosit`,
        );
      }
      const before = (await this.deps.store.listMedia(productId)).map((r) => r.mediaId);
      if (before.join("|") === data.mediaIds.join("|")) return { mediaIds: before };

      await this.deps.store.replaceMedia(productId, data.mediaIds);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.media.update",
        entity: "product",
        entityId: productId,
        before: { mediaIds: before },
        after: { mediaIds: data.mediaIds },
      });
      await this.invalidate(productCacheTags(product));
      return { mediaIds: data.mediaIds };
    });
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

export function createPrismaProductAssignmentStore(db: Db): ProductAssignmentStore {
  return {
    getProduct: (id) =>
      db.product.findUnique({ where: { id }, select: { id: true, slug: true, deletedAt: true } }),

    async listCategories(productId) {
      const rows = await db.productCategory.findMany({
        where: { productId },
        select: { categoryId: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { categoryId: "asc" }],
      });
      return rows;
    },

    async existingCategoryIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.category.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async replaceCategories(productId, rows) {
      await inTransaction(db, async (tx) => {
        await tx.productCategory.deleteMany({ where: { productId } });
        for (const row of rows) {
          await tx.productCategory.create({
            data: { productId, categoryId: row.categoryId, isPrimary: row.isPrimary },
          });
        }
      });
    },

    listMedia: (productId) =>
      db.productMedia.findMany({
        where: { productId, variantId: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          mediaId: true,
          position: true,
          media: {
            select: {
              originalName: true,
              alt: true,
              status: true,
              storageKey: true,
              width: true,
              height: true,
              blurhash: true,
              variants: true,
            },
          },
        },
      }),

    async readyMediaIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.media.findMany({
        where: { id: { in: [...ids] }, status: "ready" },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async replaceMedia(productId, mediaIds) {
      await inTransaction(db, async (tx) => {
        await tx.productMedia.deleteMany({ where: { productId, variantId: null } });
        for (const [position, mediaId] of mediaIds.entries()) {
          await tx.productMedia.create({ data: { productId, mediaId, position } });
        }
      });
    },
  };
}
