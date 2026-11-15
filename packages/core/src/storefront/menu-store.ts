import type { Prisma, PrismaClient } from "@ecom/db";
import type { MenuCategory } from "./menu";

type Db = PrismaClient | Prisma.TransactionClient;

export interface MenuStore {
  listCategories(): Promise<MenuCategory[]>;
}

/** Categoriile cu numărul de produse ACTIVE (nesterse) din fiecare; citire publică, fără date sensibile (nici preț, nici cost). */
export function createPrismaMenuStore(db: Db): MenuStore {
  return {
    async listCategories() {
      const [rows, counts] = await Promise.all([
        db.category.findMany({
          select: {
            id: true,
            parentId: true,
            slug: true,
            name: true,
            path: true,
            depth: true,
            sortOrder: true,
          },
        }),
        db.productCategory.groupBy({
          by: ["categoryId"],
          where: { product: { deletedAt: null, status: "active" } },
          _count: { _all: true },
        }),
      ]);
      const byCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return rows.map((row) => ({ ...row, productCount: byCategory.get(row.id) ?? 0 }));
    },
  };
}
