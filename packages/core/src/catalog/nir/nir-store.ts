import type { Prisma } from "@ecom/db";
import { type PrismaClient } from "@ecom/db";
import { DEFAULT_MEASURE_UNIT_CODE } from "../../inventory/constants";
import { effectiveMeasureUnit } from "../../inventory/units";
import type { NirCatalog, NirPlanItem, NirReport, NirVariant } from "./nir-plan";

type Db = PrismaClient | Prisma.TransactionClient;

export type NirImportStatus = "previewed" | "queued" | "running" | "completed" | "failed";

/** Un import, cu tot ce poartă: planul și raportul conțin prețuri de achiziție (doar pentru cei cu `products.cost.view`). */
export interface NirImportRecord {
  id: string;
  createdById: string | null;
  status: NirImportStatus;
  fileName: string;
  format: "csv" | "xls" | "xlsx";
  sizeBytes: number;
  fileHash: string;
  rowCount: number;
  itemCount: number;
  processedItems: number;
  plan: NirPlanItem[];
  report: NirReport;
  errorMessage: string | null;
  expiresAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface NewNirImport {
  createdById: string;
  fileName: string;
  format: "csv" | "xls" | "xlsx";
  sizeBytes: number;
  fileHash: string;
  rowCount: number;
  plan: NirPlanItem[];
  report: NirReport;
  expiresAt: Date;
}

/** Rezultatul aplicării unui lot: ce variante au fost într-adevăr actualizate; restul nu aveau data mai veche decât a fișierului. */
export interface ApplyOutcome {
  updatedVariantIds: string[];
}

export interface NirStore {
  /** Variantele (necoșul de gunoi) ale căror SKU se potrivește exact sau fără diferență de majuscule cu unul dintre coduri. */
  loadCatalog(codes: readonly string[]): Promise<NirCatalog>;
  create(data: NewNirImport): Promise<NirImportRecord>;
  get(id: string): Promise<NirImportRecord | null>;
  list(limit: number): Promise<Array<Omit<NirImportRecord, "plan">>>;
  /** `previewed` → `queued`, atomic, doar dacă previzualizarea nu a expirat. `false` = nu mai e în starea așteptată. */
  queue(id: string, now: Date): Promise<boolean>;
  /** `queued` → `running`, atomic; doar un worker revendică un import. */
  claim(id: string, now: Date): Promise<boolean>;
  /**
   * Aplică un lot de actualizări, atomic: pentru fiecare variantă scrie costul și data DOAR dacă data din fișier e STRICT mai nouă
   * decât cea curentă, și adaugă un rând în `CostPriceHistory` DOAR pentru ce s-a actualizat. Variantele se blochează în ordinea
   * identificatorilor (fără blocaje încrucișate), iar condiția se reevaluează sub blocare: două importuri simultane nu dublează
   * istoricul și niciunul nu coboară o dată.
   */
  applyBatch(importId: string, items: readonly NirPlanItem[]): Promise<ApplyOutcome>;
  progress(id: string, processedItems: number): Promise<void>;
  finish(
    id: string,
    result:
      | { status: "completed"; report: NirReport; processedItems: number; now: Date }
      | { status: "failed"; message: string; now: Date },
  ): Promise<void>;
}

const day = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);

const UNIT_SELECT = { code: true, smartbillName: true } as const;

const VARIANT_SELECT = {
  id: true,
  sku: true,
  costPriceDate: true,
  priceBasis: true,
  smartbillMode: true,
  smartbillUnitName: true,
  measureUnit: { select: UNIT_SELECT },
  product: { select: { priceBasis: true, measureUnit: { select: UNIT_SELECT } } },
} satisfies Prisma.ProductVariantSelect;

type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_SELECT }>;

/** Prisma cu adaptorul `pg` execută `select`-ul imbricat ca interogări separate: relația poate veni `null` dacă produsul a dispărut. */
const orNull = <T>(value: T): T | null => value;

function toVariant(row: VariantRow): NirVariant | null {
  const product = orNull(row.product);
  if (!product) return null;
  const unit = effectiveMeasureUnit<{ code: string; smartbillName: string | null } | null>(
    row.measureUnit,
    product.measureUnit,
    null,
  );
  const named = row.smartbillUnitName?.trim() || unit?.smartbillName?.trim() || unit?.code;
  const mode = row.smartbillMode ?? "same_unit";
  return {
    variantId: row.id,
    sku: row.sku,
    currentDate: day(row.costPriceDate),
    smartbillMode: mode === "steps" || mode === "ratio" ? mode : "same_unit",
    priceBasis: (row.priceBasis ?? product.priceBasis) === "step" ? "step" : "unit",
    expectedUnit: named && named !== "" ? named : DEFAULT_MEASURE_UNIT_CODE,
  };
}

const CODE_CHUNK = 1000;

type ImportRow = Prisma.NirImportGetPayload<{ omit: { plan: true } }>;

function summary(row: ImportRow): Omit<NirImportRecord, "plan"> {
  return {
    id: row.id,
    createdById: row.createdById,
    status: row.status as NirImportStatus,
    fileName: row.fileName,
    format: row.format as NirImportRecord["format"],
    sizeBytes: row.sizeBytes,
    fileHash: row.fileHash,
    rowCount: row.rowCount,
    itemCount: row.itemCount,
    processedItems: row.processedItems,
    report: row.report as unknown as NirReport,
    errorMessage: row.errorMessage,
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

function record(row: ImportRow & { plan: Prisma.JsonValue }): NirImportRecord {
  return { ...summary(row), plan: row.plan as unknown as NirPlanItem[] };
}

export function createPrismaNirStore(db: Db): NirStore {
  const transact = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const client = db as PrismaClient;
    return typeof client.$transaction === "function" ? client.$transaction((tx) => fn(tx)) : fn(db);
  };

  return {
    async loadCatalog(codes) {
      const unique = [...new Set(codes.map((code) => code.trim()).filter((code) => code !== ""))];
      const exact = new Map<string, NirVariant>();
      const lower = new Map<string, NirVariant[]>();
      for (let i = 0; i < unique.length; i += CODE_CHUNK) {
        const chunk = unique.slice(i, i + CODE_CHUNK);
        const found = await db.$queryRaw<Array<{ id: string }>>`
          SELECT v.id FROM product_variant v
          WHERE v.sku = ANY(${chunk}::text[]) OR lower(v.sku) = ANY(${chunk.map((c) => c.toLowerCase())}::text[])`;
        if (found.length === 0) continue;
        const rows = await db.productVariant.findMany({
          where: { id: { in: found.map((row) => row.id) }, product: { deletedAt: null } },
          select: VARIANT_SELECT,
        });
        for (const row of rows) {
          const variant = toVariant(row);
          if (!variant) continue;
          exact.set(variant.sku, variant);
          const key = variant.sku.toLowerCase();
          lower.set(key, [...(lower.get(key) ?? []), variant]);
        }
      }
      return {
        exact: (code) => exact.get(code.trim()),
        caseInsensitive: (code) => lower.get(code.trim().toLowerCase()) ?? [],
      };
    },

    async create(data) {
      const row = await db.nirImport.create({
        data: {
          createdById: data.createdById,
          fileName: data.fileName,
          format: data.format,
          sizeBytes: data.sizeBytes,
          fileHash: data.fileHash,
          rowCount: data.rowCount,
          itemCount: data.plan.length,
          plan: data.plan as unknown as Prisma.InputJsonValue,
          report: data.report as unknown as Prisma.InputJsonValue,
          expiresAt: data.expiresAt,
        },
      });
      return record(row);
    },

    async get(id) {
      const row = await db.nirImport.findUnique({ where: { id } });
      return row ? record(row) : null;
    },

    async list(limit) {
      const rows = await db.nirImport.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: limit,
        omit: { plan: true },
      });
      return rows.map(summary);
    },

    async queue(id, now) {
      const result = await db.nirImport.updateMany({
        where: { id, status: "previewed", expiresAt: { gt: now } },
        data: { status: "queued" },
      });
      return result.count === 1;
    },

    async claim(id, now) {
      const result = await db.nirImport.updateMany({
        where: { id, status: "queued" },
        data: { status: "running", startedAt: now },
      });
      return result.count === 1;
    },

    async applyBatch(importId, items) {
      if (items.length === 0) return { updatedVariantIds: [] };
      const sorted = [...items].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
      return transact(async (tx) => {
        const ids = sorted.map((item) => item.variantId);
        // blocare în ordinea identificatorilor: două importuri nu se blochează încrucișat
        await tx.$queryRaw`SELECT id FROM product_variant WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
        const rows = await tx.$queryRaw<Array<{ variantId: string }>>`
          WITH input(id, amount, entry_date) AS (
            SELECT * FROM unnest(
              ${ids}::text[],
              ${sorted.map((item) => item.costMinor)}::int[],
              ${sorted.map((item) => item.date)}::date[]
            )
          ), changed AS (
            UPDATE product_variant v
            SET "costPrice" = i.amount, "costPriceDate" = i.entry_date::timestamp, "updatedAt" = now()
            FROM input i
            WHERE v.id = i.id AND (v."costPriceDate" IS NULL OR v."costPriceDate"::date < i.entry_date)
            RETURNING v.id AS variant_id, i.amount, i.entry_date
          ), written AS (
            INSERT INTO cost_price_history (id, "variantId", "costPrice", "effectiveDate", source, "importId", "createdAt")
            SELECT gen_random_uuid()::text, variant_id, amount, entry_date::timestamp, 'import', ${importId}::text, now()
            FROM changed
            RETURNING "variantId"
          )
          SELECT "variantId" FROM written`;
        return { updatedVariantIds: rows.map((row) => row.variantId) };
      });
    },

    async progress(id, processedItems) {
      await db.nirImport.updateMany({ where: { id, status: "running" }, data: { processedItems } });
    },

    async finish(id, result) {
      if (result.status === "completed") {
        await db.nirImport.update({
          where: { id },
          data: {
            status: "completed",
            report: result.report as unknown as Prisma.InputJsonValue,
            processedItems: result.processedItems,
            finishedAt: result.now,
          },
        });
        return;
      }
      await db.nirImport.update({
        where: { id },
        data: { status: "failed", errorMessage: result.message, finishedAt: result.now },
      });
    },
  };
}
