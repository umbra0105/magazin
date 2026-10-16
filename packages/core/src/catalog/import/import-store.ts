import { Prisma, type PrismaClient } from "@ecom/db";
import type { ImportFieldKey } from "./import-fields";
import {
  buildBrandIndex,
  buildCategoryIndex,
  type ExistingVariant,
  type ImportCounts,
  type ImportSnapshot,
} from "./import-plan";
import type { ImportFormat } from "./import-file";
import type { WooPlanExtras, WooOptions, WooReportSection } from "./woo/woo-types";
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
  summary: ImportCounts | null;
  report: ImportReport | null;
  errorMessage: string | null;
  expiresAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
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
  /** Importurile expirate (care nu rulează), cu fișierul lor. */
  findExpired(now: Date, limit: number): Promise<{ id: string; storageKey: string | null }[]>;
  loadSnapshot(lookups: {
    skus: readonly string[];
    slugs: readonly string[];
  }): Promise<ImportSnapshot>;
  /** Instantaneul pentru profilul WooCommerce: cel generic + categorii, branduri, atribute, relații etc. */
  loadWooSnapshot(lookups: WooLookups): Promise<WooSnapshot>;
  /** Interogări și scrieri ale profilului WooCommerce (ID din magazinul vechi, căutări după SKU / ID). */
  woo: WooQueries;
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
        where: { expiresAt: { lt: now }, status: { notIn: ["running", "queued"] } },
        orderBy: { expiresAt: "asc" },
        take: limit,
        select: { id: true, storageKey: true },
      });
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
      }[] = [];
      for (const part of chunks(lowerSkus, LOOKUP_CHUNK)) {
        // fără coloanele prețului de achiziție: lista e explicită
        variantRows.push(
          ...(await db.$queryRaw<(typeof variantRows)[number][]>(Prisma.sql`
            SELECT id, "productId", sku, ean, price, "salePrice", "warrantyMonths",
                   "weightGrams", "lengthMm", "widthMm", "heightMm"
            FROM product_variant
            WHERE lower(sku) = ANY(${part}::text[])
          `)),
        );
      }

      const productIds = [...new Set(variantRows.map((v) => v.productId))];
      const products = new Map<string, ExistingVariant["product"]>();
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
            categories: { select: { categoryId: true, isPrimary: true } },
          },
        });
        for (const p of rows) {
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

      const [categories, brands] = await Promise.all([
        db.category.findMany({ select: { id: true, name: true, parentId: true } }),
        db.brand.findMany({ select: { id: true, name: true } }),
      ]);
      return {
        variantsBySku,
        slugOwners,
        categoryIndex: buildCategoryIndex(categories),
        brandIndex: buildBrandIndex(brands),
      };
    },
  };
  return store;
}
