import type { Prisma, PrismaClient } from "@ecom/db";
import type { NodeUpdate } from "./category-tree";

export interface CategoryRecord {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  excludeFromGroupDiscount: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  imageMediaId: string | null;
  legacyId: string | null;
  legacyUrl: string | null;
}

export interface CategoryWithCount extends CategoryRecord {
  /** Produse neșterse din categorie. */
  productCount: number;
}

export interface NewCategoryData {
  parentId: string | null;
  slug: string;
  name: string;
  path: string;
  depth: number;
  sortOrder: number;
  description?: string | null;
  excludeFromGroupDiscount?: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  imageMediaId?: string | null;
  legacyId?: string | null;
  legacyUrl?: string | null;
}

export interface CategoryStore {
  listAll(): Promise<CategoryWithCount[]>;
  get(id: string): Promise<CategoryRecord | null>;
  /** Fratele cu aceeași adresă (fără diferență de majuscule) în același părinte. */
  findSiblingBySlug(
    parentId: string | null,
    slug: string,
    excludeId?: string,
  ): Promise<{ id: string; name: string } | null>;
  create(data: NewCategoryData): Promise<CategoryRecord>;
  update(id: string, data: Partial<NewCategoryData>): Promise<CategoryRecord>;
  /** Aplică o listă de actualizări de structură (părinte, adâncime, cale, ordine), atomic. */
  applyUpdates(updates: readonly NodeUpdate[]): Promise<void>;
  /**
   * Rulează `fn` cu structura arborelui blocată: o altă operație de acest fel (alt administrator, alt proces)
   * așteaptă să termine, apoi citește arborele proaspăt. Citirea → planul → `applyUpdates` sunt scrieri ale
   * rândurilor COMPLETE din citirea făcută; fără blocare, două mutări simultane își șterg una alteia efectul.
   */
  serialized<T>(fn: () => Promise<T>): Promise<T>;
  countChildren(id: string): Promise<number>;
  /** Legături cu produse: `active` = produse neșterse, `deleted` = produse șterse (soft delete). */
  countProducts(id: string): Promise<{ active: number; deleted: number }>;
  delete(id: string): Promise<void>;
  mediaExists(mediaId: string): Promise<boolean>;
}

const select = {
  id: true,
  parentId: true,
  slug: true,
  name: true,
  description: true,
  path: true,
  depth: true,
  sortOrder: true,
  excludeFromGroupDiscount: true,
  seoTitle: true,
  seoDescription: true,
  imageMediaId: true,
  legacyId: true,
  legacyUrl: true,
} satisfies Prisma.CategorySelect;

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

export function createPrismaCategoryStore(db: Db): CategoryStore {
  return {
    async listAll() {
      const [rows, counts] = await Promise.all([
        db.category.findMany({ select }),
        db.productCategory.groupBy({
          by: ["categoryId"],
          where: { product: { deletedAt: null } },
          _count: { _all: true },
        }),
      ]);
      const byCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return rows.map((r) => ({ ...r, productCount: byCategory.get(r.id) ?? 0 }));
    },

    get: (id) => db.category.findUnique({ where: { id }, select }),

    findSiblingBySlug(parentId, slug, excludeId) {
      return db.category.findFirst({
        where: {
          parentId,
          slug: { equals: slug, mode: "insensitive" },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true, name: true },
      });
    },

    create: (data) => db.category.create({ data, select }),

    update: (id, data) => db.category.update({ where: { id }, data, select }),

    async applyUpdates(updates) {
      if (updates.length === 0) return;
      await inTransaction(db, async (tx) => {
        // Căile sunt unice: într-o mutare/redenumire căile noi nu le ciocnesc pe cele vechi ale
        // aceluiași subarbore decât tranzitoriu, deci actualizările se fac în două treceri
        // (mai întâi căi temporare unice, apoi cele finale).
        for (const u of updates) {
          await tx.category.update({
            where: { id: u.id },
            data: { path: `~${u.id}` },
          });
        }
        for (const u of updates) {
          await tx.category.update({
            where: { id: u.id },
            data: { parentId: u.parentId, depth: u.depth, path: u.path, sortOrder: u.sortOrder },
          });
        }
      });
    },

    async serialized(fn) {
      // Blocare consultativă PE TRANZACȚIE (se eliberează la sfârșitul ei, chiar la eroare). Operațiile din `fn`
      // rulează pe alte conexiuni, dar nu pot începe altă operație serializată cât timp aceasta ține blocarea.
      const lock = (tx: Prisma.TransactionClient | PrismaClient) =>
        tx.$executeRaw`select pg_advisory_xact_lock(hashtext('ecom:category-tree'))`;
      // Clientul rădăcină are `$connect`; un client deja în tranzacție (testele cu rollback, importul) nu: acolo
      // blocarea se ia pe tranzacția existentă și ține până la sfârșitul ei, fără tranzacție imbricată.
      if (!("$connect" in db)) {
        await lock(db);
        return fn();
      }
      let result: Awaited<ReturnType<typeof fn>> | undefined;
      await db.$transaction(
        async (tx) => {
          await lock(tx);
          result = await fn();
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      return result as Awaited<ReturnType<typeof fn>>;
    },

    countChildren: (id) => db.category.count({ where: { parentId: id } }),

    async countProducts(id) {
      const [active, deleted] = await Promise.all([
        db.productCategory.count({ where: { categoryId: id, product: { deletedAt: null } } }),
        db.productCategory.count({
          where: { categoryId: id, product: { deletedAt: { not: null } } },
        }),
      ]);
      return { active, deleted };
    },

    async delete(id) {
      await db.category.delete({ where: { id } });
    },

    async mediaExists(mediaId) {
      return (await db.media.count({ where: { id: mediaId } })) > 0;
    },
  };
}
