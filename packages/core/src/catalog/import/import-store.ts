import { Prisma, type PrismaClient } from "@ecom/db";
import type { ImportFieldKey } from "./import-fields";
import {
  buildBrandIndex,
  buildCategoryIndex,
  type ExistingVariant,
  type ImportCounts,
  type ImportSnapshot,
} from "./import-plan";
import type { ExistingSale } from "./import-sale";
import type { ImportFormat } from "./import-file";
import type { WooPlanExtras, WooOptions, WooReportSection } from "./woo/woo-types";
import { createImageTaskStore, type ImageTaskStore } from "./woo/image-store";
import { createWooQueries, type WooLookups, type WooQueries } from "./woo/woo-store";
import type { WooSnapshot } from "./woo/woo-plan";

/**
 * Accesul la date pentru importul de produse: starea importului (`ProductImport`) și instantaneul
 * catalogului de care are nevoie planificarea. Citirile de variante aleg coloanele EXPLICIT, fără
 * prețul de achiziție (testul de arhitectură al costului acoperă acest fișier).
 */

export type ImportStatus = "uploaded" | "validated" | "queued" | "running" | "completed" | "failed";

export interface ImportReportEntry {
  row: number;
  sku: string;
  outcome: "new" | "updated" | "unchanged" | "skipped" | "error";
  messages: string[];
  /** Câmpurile schimbate (etichetele din interfață). */
  changed: string[];
}

export interface ImportReport {
  counts: ImportCounts;
  fileWarnings: string[];
  /** Rândurile cu ceva de spus (fără cele «neschimbate»); tăiat la `REPORT_ENTRY_LIMIT`. */
  entries: ImportReportEntry[];
  truncated: boolean;
  /** Doar la profilul WooCommerce: ce se creează, statistici, coloane ignorate. */
  woo?: WooReportSection;
}

export const REPORT_ENTRY_LIMIT = 2000;

/**
 * Maparea salvată la verificare: lista câmpurilor pe coloane (importul generic) sau profilul WooCommerce cu
 * opțiunile alese (coloanele se recunosc după antet, deci nu se salvează).
 */
export type ImportMappingRecord =
  (ImportFieldKey | null)[] | { profile: "woocommerce"; options: WooOptions };

export function isWooMapping(
  mapping: ImportMappingRecord | null,
): mapping is { profile: "woocommerce"; options: WooOptions } {
  return mapping !== null && !Array.isArray(mapping) && mapping.profile === "woocommerce";
}

export type { WooPlanExtras };

/** Contoarele unui import terminat, plus câte entități a creat (profilul WooCommerce). */
export type ImportSummary = ImportCounts & {
  created?: { categories: number; brands: number; attributes: number };
  /** Imaginile din fișier, la momentul aplicării (descărcarea rulează apoi în fundal). */
  images?: { total: number; accepted: number; rejected: number; queued: number };
};

/** Stările în care un import a ajuns la aplicare (intră în istoric). */
export const APPLIED_STATUSES = ["queued", "running", "completed", "failed"] as const;

export interface ImportRecord {
  id: string;
  createdById: string | null;
  status: ImportStatus;
  fileName: string;
  format: ImportFormat;
  sizeBytes: number;
  fileHash: string;
  storageKey: string | null;
  delimiter: string | null;
  mapping: ImportMappingRecord | null;
  planHash: string | null;
  rowCount: number;
  processedRows: number;
  summary: ImportSummary | null;
  report: ImportReport | null;
  errorMessage: string | null;
  expiresAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Un rând din istoric: fără raportul detaliat (greu), cu utilizatorul și dacă detaliul mai există. */
export interface ImportHistoryRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: ImportStatus;
  fileName: string;
  format: ImportFormat;
  mapping: ImportMappingRecord | null;
  rowCount: number;
  processedRows: number;
  summary: ImportSummary | null;
  errorMessage: string | null;
  userName: string | null;
  userEmail: string | null;
  /** Raportul detaliat pe rânduri mai există (nu a fost purjat). */
  hasReport: boolean;
}

export interface NewImport {
  createdById: string;
  fileName: string;
  format: ImportFormat;
  sizeBytes: number;
  fileHash: string;
  storageKey: string;
  delimiter: string | null;
  rowCount: number;
  expiresAt: Date;
}

export type ImportPatch = Partial<
  Pick<
    ImportRecord,
    | "status"
    | "delimiter"
    | "mapping"
    | "planHash"
    | "rowCount"
    | "processedRows"
    | "summary"
    | "report"
    | "errorMessage"
    | "storageKey"
    | "expiresAt"
    | "startedAt"
    | "finishedAt"
  >
>;

export interface ProductImportStore {
  create(data: NewImport): Promise<ImportRecord>;
  get(id: string): Promise<ImportRecord | null>;
  update(id: string, patch: ImportPatch): Promise<ImportRecord>;
  /** Trece starea de la una din `from` la `to`, ATOMIC; `false` dacă altcineva a schimbat-o între timp. */
  transition(id: string, from: readonly ImportStatus[], to: ImportStatus): Promise<boolean>;
  delete(id: string): Promise<void>;
  /** Importurile neaplicate (doar încărcate sau verificate) expirate, cu fișierul lor. Cele aplicate NU expiră: sunt istoric. */
  findExpired(now: Date, limit: number): Promise<{ id: string; storageKey: string | null }[]>;
  /** Istoricul: importurile care au ajuns la aplicare, cele mai noi întâi. */
  listApplied(page: {
    skip: number;
    take: number;
  }): Promise<{ rows: ImportHistoryRow[]; total: number }>;
  /** Un import aplicat (al oricărui utilizator), cu raportul lui dacă mai există. */
  getApplied(id: string): Promise<{ row: ImportHistoryRow; report: ImportReport | null } | null>;
  /** Șterge raportul detaliat al importurilor aplicate al căror termen de păstrare a trecut; sumarul rămâne. */
  purgeReports(now: Date): Promise<number>;
  loadSnapshot(lookups: {
    skus: readonly string[];
    slugs: readonly string[];
  }): Promise<ImportSnapshot>;
  /** Instantaneul pentru profilul WooCommerce: cel generic + categorii, branduri, atribute, relații etc. */
  loadWooSnapshot(lookups: WooLookups): Promise<WooSnapshot>;
  /** Interogări și scrieri ale profilului WooCommerce (ID din magazinul vechi, căutări după SKU / ID). */
  woo: WooQueries;
  /** Sarcinile de descărcare a imaginilor (profilul WooCommerce, punctul 15b). */
  images: ImageTaskStore;
}

type Db = PrismaClient | Prisma.TransactionClient;

type Row = Awaited<ReturnType<PrismaClient["productImport"]["findUniqueOrThrow"]>>;

const toRecord = (row: Row): ImportRecord => ({
  id: row.id,
  createdById: row.createdById,
  status: row.status as ImportStatus,
  fileName: row.fileName,
  format: row.format as ImportFormat,
  sizeBytes: row.sizeBytes,
  fileHash: row.fileHash,
  storageKey: row.storageKey,
  delimiter: row.delimiter,
  mapping: row.mapping as ImportRecord["mapping"],
  planHash: row.planHash,
  rowCount: row.rowCount,
  processedRows: row.processedRows,
  summary: row.summary as ImportRecord["summary"],
  report: row.report as ImportRecord["report"],
  errorMessage: row.errorMessage,
  expiresAt: row.expiresAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

type HistorySelected = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: string;
  fileName: string;
  format: string;
  mapping: Prisma.JsonValue | null;
  rowCount: number;
  processedRows: number;
  summary: Prisma.JsonValue | null;
  errorMessage: string | null;
  createdBy: { name: string; email: string } | null;
};

const toHistoryRow = (row: HistorySelected, hasReport: boolean): ImportHistoryRow => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  status: row.status as ImportStatus,
  fileName: row.fileName,
  format: row.format as ImportFormat,
  mapping: row.mapping as ImportMappingRecord | null,
  rowCount: row.rowCount,
  processedRows: row.processedRows,
  summary: row.summary as ImportSummary | null,
  errorMessage: row.errorMessage,
  userName: row.createdBy?.name ?? null,
  userEmail: row.createdBy?.email ?? null,
  hasReport,
});

const jsonValue = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

/** Câte SKU-uri se caută într-o singură interogare. */
const LOOKUP_CHUNK = 1000;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export function createPrismaProductImportStore(db: Db): ProductImportStore {
  const woo = createWooQueries(db);
  const store: ProductImportStore = {
    woo,
    images: createImageTaskStore(db),
    async loadWooSnapshot(lookups) {
      const base = await store.loadSnapshot({ skus: lookups.skus, slugs: [] });
      return { ...base, woo: await woo.loadExtras(base, lookups) };
    },

    async create(data) {
      const row = await db.productImport.create({
        data: { ...data, status: "uploaded" },
      });
      return toRecord(row);
    },

    async get(id) {
      const row = await db.productImport.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async update(id, patch) {
      const { mapping, summary, report, ...rest } = patch;
      const row = await db.productImport.update({
        where: { id },
        data: {
          ...rest,
          ...(mapping !== undefined && { mapping: jsonValue(mapping) }),
          ...(summary !== undefined && { summary: jsonValue(summary) }),
          ...(report !== undefined && { report: jsonValue(report) }),
        },
      });
      return toRecord(row);
    },

    async transition(id, from, to) {
      const result = await db.productImport.updateMany({
        where: { id, status: { in: [...from] } },
        data: { status: to },
      });
      return result.count === 1;
    },

    async delete(id) {
      await db.productImport.deleteMany({ where: { id } });
    },

    async findExpired(now, limit) {
      return db.productImport.findMany({
        where: { expiresAt: { lt: now }, status: { in: ["uploaded", "validated"] } },
        orderBy: { expiresAt: "asc" },
        take: limit,
        select: { id: true, storageKey: true },
      });
    },

    async listApplied({ skip, take }) {
      const where = { status: { in: [...APPLIED_STATUSES] } };
      const [total, rows] = await Promise.all([
        db.productImport.count({ where }),
        db.productImport.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take,
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            startedAt: true,
            finishedAt: true,
            status: true,
            fileName: true,
            format: true,
            mapping: true,
            rowCount: true,
            processedRows: true,
            summary: true,
            errorMessage: true,
            createdBy: { select: { name: true, email: true } },
          },
        }),
      ]);
      // raportul detaliat e greu: nu se aduce în listă, doar dacă mai există
      const purged = new Set(
        (
          await db.productImport.findMany({
            where: { id: { in: rows.map((r) => r.id) }, report: { equals: Prisma.DbNull } },
            select: { id: true },
          })
        ).map((r) => r.id),
      );
      return {
        total,
        rows: rows.map((row) => toHistoryRow(row, !purged.has(row.id))),
      };
    },

    async getApplied(id) {
      const row = await db.productImport.findFirst({
        where: { id, status: { in: [...APPLIED_STATUSES] } },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          fileName: true,
          format: true,
          mapping: true,
          rowCount: true,
          processedRows: true,
          summary: true,
          errorMessage: true,
          report: true,
          createdBy: { select: { name: true, email: true } },
        },
      });
      if (!row) return null;
      return {
        row: toHistoryRow(row, row.report !== null),
        report: (row.report as ImportReport | null) ?? null,
      };
    },

    async purgeReports(now) {
      const result = await db.productImport.updateMany({
        where: {
          status: { in: ["completed", "failed"] },
          expiresAt: { lt: now },
          report: { not: Prisma.DbNull },
        },
        data: { report: Prisma.DbNull },
      });
      return result.count;
    },

    async loadSnapshot({ skus, slugs }) {
      const lowerSkus = [...new Set(skus.map((s) => s.toLowerCase()))];
      const variantRows: {
        id: string;
        productId: string;
        sku: string;
        ean: string | null;
        price: number;
        salePrice: number | null;
        warrantyMonths: number | null;
        weightGrams: number | null;
        lengthMm: number | null;
        widthMm: number | null;
        heightMm: number | null;
        measureUnitId: string | null;
        priceBasis: string | null;
        saleStep: number | null;
        minSteps: number | null;
        manageStock: boolean | null;
        stockStatus: string | null;
        smartbillMode: string | null;
        smartbillUnitName: string | null;
        smartbillRatio: number | null;
      }[] = [];
      for (const part of chunks(lowerSkus, LOOKUP_CHUNK)) {
        // fără coloanele prețului de achiziție: lista e explicită
        variantRows.push(
          ...(await db.$queryRaw<(typeof variantRows)[number][]>(Prisma.sql`
            SELECT id, "productId", sku, ean, price, "salePrice", "warrantyMonths",
                   "weightGrams", "lengthMm", "widthMm", "heightMm",
                   "measureUnitId", "priceBasis", "saleStep", "minSteps", "manageStock", "stockStatus",
                   "smartbillMode", "smartbillUnitName", "smartbillRatio"
            FROM product_variant
            WHERE lower(sku) = ANY(${part}::text[])
          `)),
        );
      }

      const productIds = [...new Set(variantRows.map((v) => v.productId))];
      const products = new Map<string, ExistingVariant["product"]>();
      const productSale = new Map<string, ExistingSale["product"]>();
      for (const part of chunks(productIds, LOOKUP_CHUNK)) {
        const rows = await db.product.findMany({
          where: { id: { in: part } },
          select: {
            id: true,
            title: true,
            slug: true,
            subtitle: true,
            description: true,
            status: true,
            deletedAt: true,
            brandId: true,
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
            variants: { select: { id: true } },
            categories: { select: { categoryId: true, isPrimary: true } },
          },
        });
        for (const p of rows) {
          productSale.set(p.id, {
            measureUnitId: p.measureUnitId,
            priceBasis: p.priceBasis,
            saleStep: p.saleStep,
            minSteps: p.minSteps,
            saleStepLabel: p.saleStepLabel,
            leadTimeDays: p.leadTimeDays,
            manageStock: p.manageStock,
            stockStatus: p.stockStatus,
            type: p.type,
            variantIds: p.variants.map((v) => v.id),
          });
          products.set(p.id, {
            title: p.title,
            slug: p.slug,
            subtitle: p.subtitle,
            description: p.description,
            status: p.status,
            deleted: p.deletedAt !== null,
            brandId: p.brandId,
            shippingClass: p.shippingClass,
            categoryIds: [...p.categories]
              .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
              .map((c) => c.categoryId),
          });
        }
      }

      const variantsBySku = new Map<string, ExistingVariant>();
      for (const v of variantRows) {
        const product = products.get(v.productId);
        if (!product) continue;
        variantsBySku.set(v.sku.toLowerCase(), {
          variantId: v.id,
          productId: v.productId,
          sku: v.sku,
          ean: v.ean,
          price: v.price,
          salePrice: v.salePrice,
          warrantyMonths: v.warrantyMonths,
          weightGrams: v.weightGrams,
          lengthMm: v.lengthMm,
          widthMm: v.widthMm,
          heightMm: v.heightMm,
          sale: {
            variant: {
              measureUnitId: v.measureUnitId,
              priceBasis: v.priceBasis,
              saleStep: v.saleStep,
              minSteps: v.minSteps,
              manageStock: v.manageStock,
              stockStatus: v.stockStatus,
              smartbillMode: v.smartbillMode,
              smartbillUnitName: v.smartbillUnitName,
              smartbillRatio: v.smartbillRatio,
            },
            product: productSale.get(v.productId) as ExistingSale["product"],
          },
          product,
        });
      }

      const slugOwners = new Map<string, string>();
      for (const part of chunks([...new Set(slugs.map((s) => s.toLowerCase()))], LOOKUP_CHUNK)) {
        const rows = await db.$queryRaw<{ id: string; slug: string }[]>(Prisma.sql`
          SELECT id, slug FROM product WHERE lower(slug) = ANY(${part}::text[])
        `);
        for (const r of rows) slugOwners.set(r.slug.toLowerCase(), r.id);
      }

      const [categories, brands, units] = await Promise.all([
        db.category.findMany({ select: { id: true, name: true, parentId: true } }),
        db.brand.findMany({ select: { id: true, name: true } }),
        db.measureUnit.findMany({
          select: {
            id: true,
            code: true,
            name: true,
            symbol: true,
            decimals: true,
            isActive: true,
          },
        }),
      ]);
      return {
        variantsBySku,
        slugOwners,
        categoryIndex: buildCategoryIndex(categories),
        brandIndex: buildBrandIndex(brands),
        units,
      };
    },
  };
  return store;
}
