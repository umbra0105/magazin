import type { Prisma, PrismaClient } from "@ecom/db";
import { quantityFromTicks } from "@ecom/shared";
import { DEFAULT_MEASURE_UNIT_CODE } from "./constants";
import { effectiveSaleStep } from "./sale-config";
import type { StockReportConversion, StockReportVariant } from "./stock-report-plan";
import { effectiveMeasureUnit } from "./units";

/**
 * Variantele catalogului în forma pe care o cere `planStockReport`: SKU, dacă stocul se gestionează (varianta peste produs),
 * unitatea așteptată în SmartBill, conversia către unitatea noastră și stocul fizic curent al depozitului. Doar citire.
 * Produsele din coșul de gunoi nu intră; un produs digital nu are stoc (apare ca negestionat).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const UNIT_SELECT = { code: true, smartbillName: true } as const;

interface UnitRef {
  code: string;
  smartbillName: string | null;
}

const variantSelect = (warehouseId: string) =>
  ({
    id: true,
    sku: true,
    manageStock: true,
    saleStep: true,
    smartbillMode: true,
    smartbillUnitName: true,
    smartbillRatio: true,
    measureUnit: { select: UNIT_SELECT },
    optionValues: {
      select: {
        option: { select: { position: true } },
        value: { select: { value: true } },
      },
    },
    inventoryItems: { where: { warehouseId }, select: { physical: true } },
    product: {
      select: {
        title: true,
        type: true,
        manageStock: true,
        saleStep: true,
        measureUnit: { select: UNIT_SELECT },
      },
    },
  }) satisfies Prisma.ProductVariantSelect;

type VariantRow = Prisma.ProductVariantGetPayload<{ select: ReturnType<typeof variantSelect> }>;

/**
 * Prisma 7.10 cu adaptorul `pg` execută `select`-ul imbricat ca interogări separate: dacă un produs e șters definitiv între
 * ele, relația obligatorie vine `null` (vezi `stock-overview-store.ts`). Rândul se omite, ca un produs șters.
 */
const orNull = <T>(value: T): T | null => value;

const BATCH = 500;

function conversionOf(row: VariantRow, step: bigint): StockReportConversion | null {
  switch (row.smartbillMode ?? "same_unit") {
    case "same_unit":
      return { mode: "same_unit" };
    case "steps":
      return { mode: "steps", step: quantityFromTicks(step) };
    case "ratio":
      // raportul lipsă e o eroare de configurare: planul o raportează, nu o ghicește
      return row.smartbillRatio === null
        ? null
        : { mode: "ratio", ratio: quantityFromTicks(BigInt(row.smartbillRatio)) };
    default:
      return null;
  }
}

function toVariant(row: VariantRow): StockReportVariant | null {
  const product = orNull(row.product);
  if (!product) return null;
  const unit = effectiveMeasureUnit<UnitRef | null>(row.measureUnit, product.measureUnit, null);
  const named = row.smartbillUnitName?.trim() || unit?.smartbillName?.trim() || unit?.code;
  const expectedUnit = named && named !== "" ? named : DEFAULT_MEASURE_UNIT_CODE;
  const step = effectiveSaleStep(row.saleStep, product.saleStep);
  const conversion = conversionOf(row, step);
  const label = row.optionValues
    .flatMap((entry) => {
      const option = orNull(entry.option);
      const value = orNull(entry.value);
      return option && value ? [{ position: option.position, value: value.value }] : [];
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.value)
    .join(" · ");
  const item = row.inventoryItems[0];
  return {
    variantId: row.id,
    sku: row.sku,
    label: label === "" ? product.title : `${product.title} · ${label}`,
    manageStock: product.type === "digital" ? false : (row.manageStock ?? product.manageStock),
    expectedUnit: conversion === null && row.smartbillMode === "ratio" ? null : expectedUnit,
    conversion: conversion ?? { mode: "same_unit" },
    currentPhysical: item ? quantityFromTicks(item.physical) : null,
  };
}

/** Toate variantele din catalog (cu SKU), în ordinea identificatorului, citite în loturi. */
export async function loadReportVariants(
  db: Db,
  warehouseId: string,
): Promise<StockReportVariant[]> {
  const out: StockReportVariant[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.productVariant.findMany({
      where: { product: { deletedAt: null } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      select: variantSelect(warehouseId),
    });
    for (const row of rows) {
      const variant = toVariant(row);
      if (variant) out.push(variant);
    }
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1]?.id;
  }
  return out;
}
