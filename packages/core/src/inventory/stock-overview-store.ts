import type { Prisma, PrismaClient } from "@ecom/db";
import { quantityFromTicks, type Quantity, type QuantityDelta } from "@ecom/shared";
import type { StockStatusValue } from "./availability";
import { DEFAULT_MEASURE_UNIT_CODE, INITIAL_MEASURE_UNITS } from "./constants";
import { effectiveSaleStep } from "./sale-config";
import type { StockOverviewSource, StockOverviewUnit } from "./stock-overview";
import { effectiveMeasureUnit } from "./units";

/**
 * Citirea pentru ecranul de stoc (Faza 5, punctul 8): variantele cu valorile EFECTIVE (varianta peste produs peste setarea
 * globală), rândul de stoc al unui depozit și istoricul mișcărilor. Doar citire; scrierile trec prin `StockService`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface StockWarehouseRef {
  id: string;
  name: string;
}

export interface StockMovementRow {
  id: string;
  kind: string;
  reason: string | null;
  note: string | null;
  deltaPhysical: QuantityDelta;
  deltaCommitted: QuantityDelta;
  physicalAfter: Quantity;
  committedAfter: Quantity;
  effectiveAt: Date;
  createdAt: Date;
  refType: string | null;
  refId: string | null;
  actorLabel: string | null;
}

export interface StockOverviewStore {
  defaultWarehouse(): Promise<StockWarehouseRef | null>;
  warehouse(id: string): Promise<StockWarehouseRef | null>;
  /** Variantele produselor care nu sunt în coșul de gunoi, în ordinea titlului, cel mult `limit`. */
  loadSources(input: {
    warehouseId: string;
    search?: string;
    /** Doar variantele acestor produse (tabul Stoc din produs, coloana din listă) */
    productIds?: readonly string[];
    limit: number;
  }): Promise<StockOverviewSource[]>;
  getSource(variantId: string, warehouseId: string): Promise<StockOverviewSource | null>;
  listMovements(input: {
    variantId: string;
    warehouseId: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: StockMovementRow[]; total: number }>;
}

/** Unitatea implicită: o unitate nulă pe produs sau variantă înseamnă EXACT «buc», fără să existe vreun rând «buc» în bază. */
const DEFAULT_UNIT: StockOverviewUnit = (() => {
  const initial = INITIAL_MEASURE_UNITS.find((u) => u.code === DEFAULT_MEASURE_UNIT_CODE);
  return { code: DEFAULT_MEASURE_UNIT_CODE, symbol: initial?.symbol ?? "buc", decimals: 0 };
})();

const UNIT_SELECT = { code: true, symbol: true, decimals: true } as const;

function sourceSelect(warehouseId: string) {
  return {
    id: true,
    sku: true,
    manageStock: true,
    stockStatus: true,
    saleStep: true,
    minSteps: true,
    measureUnit: { select: UNIT_SELECT },
    optionValues: {
      select: {
        option: { select: { position: true } },
        value: { select: { value: true } },
      },
    },
    inventoryItems: {
      where: { warehouseId },
      select: {
        physical: true,
        physicalAsOf: true,
        committed: true,
        reserved: true,
        safetyBuffer: true,
        lowStockSteps: true,
      },
    },
    product: {
      select: {
        id: true,
        title: true,
        slug: true,
        type: true,
        manageStock: true,
        stockStatus: true,
        allowBackorder: true,
        leadTimeDays: true,
        saleStep: true,
        minSteps: true,
        measureUnit: { select: UNIT_SELECT },
        brand: { select: { name: true, defaultLeadTimeDays: true } },
      },
    },
  } satisfies Prisma.ProductVariantSelect;
}

type VariantRow = Prisma.ProductVariantGetPayload<{ select: ReturnType<typeof sourceSelect> }>;

/**
 * Prisma 7.10 cu adaptorul `pg` execută `select`-ul imbricat ca interogări SEPARATE (variantele, apoi produsele lor, apoi
 * opțiunile), fără snapshot comun. Dacă un produs (sau o opțiune) e șters definitiv între ele, o relație OBLIGATORIE vine
 * `null`, deși tipul spune altceva. Citirea trece prin `orNull`, ca verificările să fie reale, nu eliminate de tip.
 */
const orNull = <T>(value: T): T | null => value;

/** `null` când produsul variantei a dispărut între interogări: rândul se omite, ca un produs șters. */
function toSource(row: VariantRow): StockOverviewSource | null {
  const product = orNull(row.product);
  if (!product) return null;
  const item = row.inventoryItems[0];
  // o valoare de opțiune fără `option` sau `value` (ștearsă între interogări) nu intră în etichetă
  const label = row.optionValues
    .flatMap((entry) => {
      const option = orNull(entry.option);
      const value = orNull(entry.value);
      return option && value ? [{ position: option.position, value: value.value }] : [];
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.value)
    .join(" · ");
  return {
    variantId: row.id,
    sku: row.sku,
    variantLabel: label === "" ? null : label,
    productId: product.id,
    productTitle: product.title,
    productSlug: product.slug,
    productType: product.type === "digital" ? "digital" : "physical",
    manageStock: row.manageStock ?? product.manageStock,
    stockStatus: (row.stockStatus ?? product.stockStatus) as StockStatusValue,
    allowBackorder: product.allowBackorder,
    unit: effectiveMeasureUnit(row.measureUnit, product.measureUnit, DEFAULT_UNIT),
    saleStep: effectiveSaleStep(row.saleStep, product.saleStep),
    minSteps: row.minSteps ?? product.minSteps,
    item: item
      ? {
          physical: quantityFromTicks(item.physical),
          physicalAsOf: item.physicalAsOf,
          committed: quantityFromTicks(item.committed),
          reserved: quantityFromTicks(item.reserved),
          safetyBuffer: quantityFromTicks(item.safetyBuffer),
          lowStockSteps: item.lowStockSteps,
        }
      : null,
    leadTime: {
      productDays: product.leadTimeDays,
      brandDays: product.brand?.defaultLeadTimeDays ?? null,
      brandName: product.brand?.name ?? null,
    },
  };
}

export function createPrismaStockOverviewStore(db: Db): StockOverviewStore {
  return {
    async defaultWarehouse() {
      return db.warehouse.findFirst({
        where: { isDefault: true },
        select: { id: true, name: true },
      });
    },

    async warehouse(id) {
      return db.warehouse.findUnique({ where: { id }, select: { id: true, name: true } });
    },

    async loadSources({ warehouseId, search, productIds, limit }) {
      const term = search?.trim();
      const rows = await db.productVariant.findMany({
        where: {
          product: {
            deletedAt: null,
            ...(productIds && { id: { in: [...productIds] } }),
          },
          ...(term && {
            OR: [
              { sku: { contains: term, mode: "insensitive" } },
              { product: { title: { contains: term, mode: "insensitive" } } },
            ],
          }),
        },
        orderBy: [
          { product: { title: "asc" } },
          { product: { id: "asc" } },
          { position: "asc" },
          { sku: "asc" },
        ],
        take: limit,
        select: sourceSelect(warehouseId),
      });
      // rândurile al căror produs a dispărut între interogări se omit (vezi `toSource`)
      return rows.flatMap((row) => {
        const source = toSource(row);
        return source ? [source] : [];
      });
    },

    async getSource(variantId, warehouseId) {
      const row = await db.productVariant.findFirst({
        where: { id: variantId, product: { deletedAt: null } },
        select: sourceSelect(warehouseId),
      });
      return row ? toSource(row) : null;
    },

    async listMovements({ variantId, warehouseId, limit, offset }) {
      const where = { variantId, warehouseId };
      const total = await db.stockMovement.count({ where });
      const rows = await db.stockMovement.findMany({
        where,
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
      });
      return {
        total,
        rows: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          reason: row.reason,
          note: row.note,
          deltaPhysical: row.deltaPhysical as QuantityDelta,
          deltaCommitted: row.deltaCommitted as QuantityDelta,
          physicalAfter: quantityFromTicks(row.physicalAfter),
          committedAfter: quantityFromTicks(row.committedAfter),
          effectiveAt: row.effectiveAt,
          createdAt: row.createdAt,
          refType: row.refType,
          refId: row.refId,
          actorLabel: row.actorLabel,
        })),
      };
    },
  };
}
