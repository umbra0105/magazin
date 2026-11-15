import type { Prisma, PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { pickVariantImage } from "../media/urls";
import type { MenuCategory } from "./menu";

type Db = PrismaClient | Prisma.TransactionClient;

export interface MenuStore {
  listCategories(): Promise<MenuCategory[]>;
}

/**
 * Categoriile cu numărul de produse ACTIVE (nesterse) din fiecare; citire publică, fără date sensibile (nici preț, nici cost).
 * Cu `storage`, fiecare categorie primește imaginea (varianta `medium` procesată) a fișierului media atașat; fără el, sau cât
 * fișierul nu e procesat, categoria rămâne fără imagine (meniul o arată ca text).
 */
export function createPrismaMenuStore(
  db: Db,
  options: { storage?: StorageDriver } = {},
): MenuStore {
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
            imageMedia: {
              select: {
                status: true,
                alt: true,
                storageKey: true,
                width: true,
                height: true,
                blurhash: true,
                variants: true,
              },
            },
          },
        }),
        db.productCategory.groupBy({
          by: ["categoryId"],
          where: { product: { deletedAt: null, status: "active" } },
          _count: { _all: true },
        }),
      ]);
      const byCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return rows.map(({ imageMedia, ...row }) => {
        const picked =
          options.storage && imageMedia?.status === "ready"
            ? pickVariantImage(imageMedia, options.storage, "medium")
            : null;
        return {
          ...row,
          productCount: byCategory.get(row.id) ?? 0,
          image: picked
            ? {
                src: picked.url,
                width: picked.width,
                height: picked.height,
                alt: imageMedia?.alt || row.name,
              }
            : null,
        };
      });
    },
  };
}
