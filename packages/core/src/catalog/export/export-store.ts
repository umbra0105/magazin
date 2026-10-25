import type { Prisma, PrismaClient } from "@ecom/db";
import { buildProductListWhere, type ProductListQuery } from "../product-list";
import { unitLabels, type ExportProductData } from "./export-rows";

/**
 * Citirea datelor pentru exportul de produse. Toate interogările au `select` EXPLICIT, fără coloanele
 * prețului de achiziție (nici `include`, nici `*`): costul nu are cum să ajungă într-un fișier de export,
 * pentru nimeni. Testul de arhitectură al costului acoperă acest fișier (nu e pe lista celor care îl pot
 * numi), iar un test cu valoare-santinelă verifică fișierul produs.
 */

/** Domeniul exportului. */
export type ExportScope =
  /** Produsele alese explicit (din lista curentă), oricare ar fi starea lor. */
  | { kind: "selection"; ids: readonly string[] }
  /** Toate produsele care respectă filtrele listei (și vederea ei: active sau coș de gunoi). */
  | { kind: "filters"; query: ListFilters; includeTrash: boolean }
  /** Tot catalogul. */
  | { kind: "all"; includeTrash: boolean };

export type ListFilters = Omit<ProductListQuery, "page" | "pageSize" | "sort">;

export interface ExportCounts {
  products: number;
  /** Rândurile exportului: câte o variantă. */
  variants: number;
}

export interface ProductExportStore {
  count(scope: ExportScope): Promise<ExportCounts>;
  /** Produsele domeniului în loturi, în ordinea id-ului (stabilă chiar dacă se editează între loturi). */
  batches(scope: ExportScope, batchSize: number): AsyncGenerator<ExportProductData[]>;
  /** Numele categoriei și al brandului dintr-un filtru, pentru foaia «Despre export». */
  filterLabels(filters: ListFilters): Promise<{ category: string | null; brand: string | null }>;
}

type Db = Pick<PrismaClient, "product" | "productVariant" | "category" | "brand" | "measureUnit">;

const EMPTY_FILTERS: ListFilters = {
  q: "",
  categoryId: null,
  brandId: null,
  status: null,
  shippingClass: null,
  stock: null,
  view: "active",
};

export function createPrismaProductExportStore(db: Db): ProductExportStore {
  async function whereOf(scope: ExportScope): Promise<Prisma.ProductWhereInput> {
    if (scope.kind === "selection") return { id: { in: [...scope.ids] } };
    if (scope.kind === "all") {
      return buildProductListWhere(db, EMPTY_FILTERS, scope.includeTrash ? "include" : "exclude");
    }
    const trash =
      scope.query.view === "deleted" ? "only" : scope.includeTrash ? "include" : "exclude";
    return buildProductListWhere(db, scope.query, trash);
  }

  /** Calea numită a fiecărei categorii (de la rădăcină), încărcată o singură dată per export. */
  async function categoryPaths(): Promise<Map<string, string>> {
    const rows = await db.category.findMany({ select: { id: true, name: true, parentId: true } });
    const byId = new Map(rows.map((c) => [c.id, c]));
    const paths = new Map<string, string>();
    for (const category of rows) {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: (typeof rows)[number] | undefined = category;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      paths.set(category.id, names.join(" > "));
    }
    return paths;
  }

  return {
    async count(scope) {
      const where = await whereOf(scope);
      const [products, variants] = await Promise.all([
        db.product.count({ where }),
        db.productVariant.count({ where: { product: where } }),
      ]);
      return { products, variants };
    },

    async *batches(scope, batchSize) {
      const where = await whereOf(scope);
      const paths = await categoryPaths();
      const unitLabel = unitLabels(
        await db.measureUnit.findMany({ select: { id: true, code: true, symbol: true } }),
      );
      const fetchBatch = (cursor: string | null) =>
        db.product.findMany({
          where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
          orderBy: { id: "asc" },
          take: batchSize,
          select: {
            id: true,
            title: true,
            subtitle: true,
            description: true,
            slug: true,
            status: true,
            shippingClass: true,
            type: true,
            manageStock: true,
            stockStatus: true,
            measureUnitId: true,
            priceBasis: true,
            saleStep: true,
            minSteps: true,
            saleStepLabel: true,
            leadTimeDays: true,
            updatedAt: true,
            brand: { select: { name: true } },
            categories: { select: { categoryId: true, isPrimary: true } },
            variants: {
              orderBy: [{ isDefault: "desc" }, { position: "asc" }, { sku: "asc" }],
              select: {
                sku: true,
                ean: true,
                price: true,
                salePrice: true,
                warrantyMonths: true,
                weightGrams: true,
                lengthMm: true,
                widthMm: true,
                heightMm: true,
                manageStock: true,
                stockStatus: true,
                priceBasis: true,
                saleStep: true,
                minSteps: true,
                smartbillMode: true,
                smartbillUnitName: true,
                smartbillRatio: true,
                measureUnitId: true,
              },
            },
          },
        });
      let after: string | null = null;
      for (;;) {
        const rows = await fetchBatch(after);
        if (rows.length === 0) return;
        yield rows.map((p): ExportProductData => ({
          id: p.id,
          title: p.title,
          subtitle: p.subtitle,
          description: p.description,
          slug: p.slug,
          status: p.status,
          shippingClass: p.shippingClass,
          brandName: p.brand?.name ?? null,
          categoryPaths: [...p.categories]
            .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
            .map((c) => paths.get(c.categoryId))
            .filter((path): path is string => path !== undefined),
          saleStepLabel: p.saleStepLabel,
          leadTimeDays: p.leadTimeDays,
          updatedAt: p.updatedAt,
          variants: p.variants.map((v) => {
            const { measureUnitId, manageStock, stockStatus, ...rest } = v;
            // valorile EFECTIVE: varianta peste produs
            const unmanaged = !(manageStock ?? p.manageStock) && p.type !== "digital";
            return {
              sku: rest.sku,
              ean: rest.ean,
              price: rest.price,
              salePrice: rest.salePrice,
              warrantyMonths: rest.warrantyMonths,
              weightGrams: rest.weightGrams,
              lengthMm: rest.lengthMm,
              widthMm: rest.widthMm,
              heightMm: rest.heightMm,
              sale: {
                unitSymbol: unitLabel.get(measureUnitId ?? p.measureUnitId ?? "") ?? null,
                priceBasis: (rest.priceBasis ?? p.priceBasis) === "step" ? "step" : "unit",
                saleStep: rest.saleStep ?? p.saleStep,
                minSteps: rest.minSteps ?? p.minSteps,
                smartbillMode: rest.smartbillMode,
                smartbillUnitName: rest.smartbillUnitName,
                smartbillRatio: rest.smartbillRatio,
                stockStatus: unmanaged ? (stockStatus ?? p.stockStatus) : null,
              },
            };
          }),
        }));
        after = rows[rows.length - 1]?.id ?? null;
        if (rows.length < batchSize) return;
      }
    },

    async filterLabels(filters) {
      const [category, brand] = await Promise.all([
        filters.categoryId
          ? db.category.findUnique({ where: { id: filters.categoryId }, select: { name: true } })
          : null,
        filters.brandId
          ? db.brand.findUnique({ where: { id: filters.brandId }, select: { name: true } })
          : null,
      ]);
      return { category: category?.name ?? null, brand: brand?.name ?? null };
    },
  };
}
