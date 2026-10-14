import type { Prisma, PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { buildMediaUrls } from "../media/urls";
import { assertCan, type PermissionSubject } from "../rbac/can";
import {
  PRODUCT_STATUSES,
  SHIPPING_CLASSES,
  STOCK_STATUSES,
  type ProductStatus,
  type ShippingClass,
  type StockStatus,
} from "./constants";

/**
 * Lista de produse din admin: interogare pe server cu căutare, filtre, sortare și paginare.
 *
 * - **Fără cost.** Niciun `select` de aici nu atinge coloanele prețului de achiziție, iar parametrii
 *   din URL (filtre, sortare) nu pot cere cost: valorile necunoscute se ignoră (testat). Testul de
 *   arhitectură al costului acoperă acest fișier (nu menționează numele coloanelor).
 * - **Performanță:** o singură interogare cu `take`/`skip`, doar câmpurile necesare, și doar `thumb`
 *   (varianta mică), niciodată originalul.
 * - Parametrii sunt validați strict: orice valoare nevalidă revine la implicit, nu aruncă.
 */

export const PRODUCT_LIST_SORTS = [
  "updated_desc",
  "title_asc",
  "title_desc",
  "status_asc",
] as const;
export type ProductListSort = (typeof PRODUCT_LIST_SORTS)[number];

export const PRODUCT_LIST_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PRODUCT_LIST_PAGE_SIZE = 25;
export const MAX_SEARCH_LENGTH = 100;

export interface ProductListQuery {
  q: string;
  categoryId: string | null;
  brandId: string | null;
  status: ProductStatus | null;
  shippingClass: ShippingClass | null;
  stock: StockStatus | null;
  page: number;
  pageSize: number;
  sort: ProductListSort;
}

type RawParams = Readonly<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined): string =>
  ((Array.isArray(value) ? value[0] : value) ?? "").trim();

const oneOf = <T extends string>(value: string, allowed: readonly T[]): T | null =>
  (allowed as readonly string[]).includes(value) ? (value as T) : null;

const idOrNull = (value: string): string | null =>
  /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;

/** Interpretează parametrii din URL. Orice nu e recunoscut (inclusiv orice încercare de sortare după cost) se ignoră. */
export function parseProductListQuery(params: RawParams): ProductListQuery {
  const size = Number.parseInt(one(params["size"]), 10);
  const page = Number.parseInt(one(params["page"]), 10);
  return {
    q: one(params["q"]).slice(0, MAX_SEARCH_LENGTH),
    categoryId: idOrNull(one(params["category"])),
    brandId: idOrNull(one(params["brand"])),
    status: oneOf(one(params["status"]), PRODUCT_STATUSES),
    shippingClass: oneOf(one(params["shipping"]), SHIPPING_CLASSES),
    stock: oneOf(one(params["stock"]), STOCK_STATUSES),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
    pageSize: (PRODUCT_LIST_PAGE_SIZES as readonly number[]).includes(size)
      ? size
      : DEFAULT_PRODUCT_LIST_PAGE_SIZE,
    sort: oneOf(one(params["sort"]), PRODUCT_LIST_SORTS) ?? "updated_desc",
  };
}

/** Rândul listei: fără cost, fără date interne. `thumb` e adresa variantei mici, sau `null`. */
export interface ProductListRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  type: string;
  brandName: string | null;
  shippingClass: string;
  manageStock: boolean;
  stockStatus: string;
  variantCount: number;
  /** Prețul de listă brut (bani), minim și maxim între variante; `null` fără variante. */
  priceMin: number | null;
  priceMax: number | null;
  /** SKU-ul variantei implicite (sau prima). */
  sku: string | null;
  /** Dacă are o singură variantă: id-ul ei (pentru editarea prețului inline). */
  singleVariantId: string | null;
  categoryNames: string[];
  thumb: string | null;
  updatedAt: Date;
}

export interface ProductListPage {
  rows: ProductListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface RawProductListRow extends Omit<ProductListRow, "thumb"> {
  thumbSource: {
    storageKey: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    variants: unknown;
  } | null;
}

export interface ProductListStore {
  list(query: ProductListQuery): Promise<{ rows: RawProductListRow[]; total: number }>;
}

type Db = Pick<PrismaClient, "product" | "category">;

export function createPrismaProductListStore(db: Db): ProductListStore {
  return {
    async list(query) {
      const and: Prisma.ProductWhereInput[] = [{ deletedAt: null }];

      if (query.q) {
        and.push({
          OR: [
            { title: { contains: query.q, mode: "insensitive" } },
            { slug: { contains: query.q, mode: "insensitive" } },
            {
              variants: {
                some: {
                  OR: [
                    { sku: { contains: query.q, mode: "insensitive" } },
                    { ean: { startsWith: query.q } },
                    { manufacturerPartNumber: { contains: query.q, mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        });
      }
      if (query.categoryId) {
        const category = await db.category.findUnique({
          where: { id: query.categoryId },
          select: { id: true, path: true },
        });
        // categoria și toate subcategoriile ei (calea începe cu a ei)
        and.push(
          category
            ? {
                categories: {
                  some: {
                    category: {
                      OR: [{ id: category.id }, { path: { startsWith: `${category.path}/` } }],
                    },
                  },
                },
              }
            : { id: "__nicio_categorie__" },
        );
      }
      if (query.brandId) and.push({ brandId: query.brandId });
      if (query.status) and.push({ status: query.status });
      if (query.shippingClass) and.push({ shippingClass: query.shippingClass });
      if (query.stock) and.push({ stockStatus: query.stock });

      const where: Prisma.ProductWhereInput = { AND: and };
      const orderBy: Prisma.ProductOrderByWithRelationInput[] =
        query.sort === "title_asc"
          ? [{ title: "asc" }, { id: "asc" }]
          : query.sort === "title_desc"
            ? [{ title: "desc" }, { id: "asc" }]
            : query.sort === "status_asc"
              ? [{ status: "asc" }, { title: "asc" }, { id: "asc" }]
              : [{ updatedAt: "desc" }, { id: "asc" }];

      const [total, rows] = await Promise.all([
        db.product.count({ where }),
        db.product.findMany({
          where,
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            type: true,
            shippingClass: true,
            manageStock: true,
            stockStatus: true,
            updatedAt: true,
            brand: { select: { name: true } },
            variants: {
              orderBy: [{ isDefault: "desc" }, { position: "asc" }],
              select: { id: true, sku: true, price: true },
            },
            categories: {
              select: { category: { select: { name: true } } },
              take: 4,
            },
            media: {
              orderBy: { position: "asc" },
              take: 1,
              select: {
                media: {
                  select: {
                    storageKey: true,
                    width: true,
                    height: true,
                    blurhash: true,
                    variants: true,
                    status: true,
                  },
                },
              },
            },
          },
        }),
      ]);

      return {
        total,
        rows: rows.map((p) => {
          const prices = p.variants.map((v) => v.price);
          const media = p.media[0]?.media;
          return {
            id: p.id,
            slug: p.slug,
            title: p.title,
            status: p.status,
            type: p.type,
            brandName: p.brand?.name ?? null,
            shippingClass: p.shippingClass,
            manageStock: p.manageStock,
            stockStatus: p.stockStatus,
            variantCount: p.variants.length,
            priceMin: prices.length > 0 ? Math.min(...prices) : null,
            priceMax: prices.length > 0 ? Math.max(...prices) : null,
            sku: p.variants[0]?.sku ?? null,
            singleVariantId: p.variants.length === 1 ? (p.variants[0]?.id ?? null) : null,
            categoryNames: p.categories.map((c) => c.category.name),
            thumbSource: media && media.status === "ready" ? media : null,
            updatedAt: p.updatedAt,
          };
        }),
      };
    },
  };
}

/**
 * Doar varianta `thumb` (WebP, apoi JPEG, apoi AVIF), niciodată originalul. Folosită de lista de
 * produse și de tabul Media al editorului.
 */
export function pickThumbUrl(
  source: {
    storageKey: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    variants: unknown;
  },
  storage: StorageDriver,
): string | null {
  const urls = buildMediaUrls(source, storage);
  const thumbs = urls.variants.filter((v) => v.name === "thumb");
  for (const format of ["webp", "jpeg", "avif"]) {
    const found = thumbs.find((v) => v.format === format);
    if (found) return found.url;
  }
  return thumbs[0]?.url ?? null;
}

export interface ProductListDeps {
  store: ProductListStore;
  storage: StorageDriver;
}

export class ProductListService {
  constructor(private readonly deps: ProductListDeps) {}

  /** Cere `products.read`. `params` = parametrii din URL, în forma lor brută. */
  async list(
    subject: PermissionSubject | null,
    params: RawParams,
  ): Promise<{ query: ProductListQuery; page: ProductListPage }> {
    assertCan(subject, "products.read");
    const query = parseProductListQuery(params);
    const { rows, total } = await this.deps.store.list(query);
    const pageCount = Math.max(Math.ceil(total / query.pageSize), 1);
    return {
      query,
      page: {
        rows: rows.map(({ thumbSource, ...row }) => ({
          ...row,
          thumb: thumbSource ? pickThumbUrl(thumbSource, this.deps.storage) : null,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        pageCount,
      },
    };
  }
}
