import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@ecom/db";
import { parseQuantity, saleStepToInt } from "@ecom/shared";
import { isTestDatabaseName } from "../../../../test/support/test-env";

/**
 * Date de probă pentru testele de stoc. În testele cu tranzacție anulată merg direct pe clientul tranzacției; în cele de
 * concurență (date COMISE, conexiuni separate) se curăță la final cu `purgeStockContext`, care ocolește TEMPORAR
 * triggerul de imuabilitate al registrului de mișcări (singura cale de a șterge mișcările unor variante de test).
 */

type Client = PrismaClient | Prisma.TransactionClient;

export interface StockContext {
  tag: string;
  warehouseId: string;
  /** Unitate de test cu 4 zecimale (nulă = «buc», fără zecimale) */
  unitId: string;
  ownsWarehouse: boolean;
  productIds: string[];
  variantIds: string[];
  snapshotIds: string[];
}

/**
 * Spațiul de nume al unui fișier de teste cu date COMISE: litere mici, 2–12, unic pe fișier (păzit de testul de arhitectură
 * `stock-fixtures-namespace`). Tag-ul contextului, deci slug-ul produselor, codul depozitului și al unității, începe cu el; așa
 * `purgeStockLeftovers` șterge doar ce a creat fișierul apelant, nu și datele aflate în lucru ale altui fișier din paralel.
 */
const NAMESPACE = /^[a-z]{2,12}$/;

export function assertStockNamespace(namespace: string): void {
  if (!NAMESPACE.test(namespace)) {
    throw new Error(
      `Spațiul de nume al fixture-urilor de stoc trebuie să aibă 2–12 litere mici (primit «${namespace}»)`,
    );
  }
}

export async function createStockContext(
  db: Client,
  options: { useDefaultWarehouse?: boolean; namespace?: string } = {},
): Promise<StockContext> {
  if (options.namespace !== undefined) assertStockNamespace(options.namespace);
  const random = randomUUID().replaceAll("-", "").slice(0, 10);
  const tag = options.namespace === undefined ? random : `${options.namespace}_${random}`;
  const unit = await db.measureUnit.create({
    data: { code: `u_${tag}`, name: `Unitate ${tag}`, symbol: "u", decimals: 4 },
  });
  let warehouseId: string | undefined;
  let ownsWarehouse = false;
  if (options.useDefaultWarehouse) {
    warehouseId = (await db.warehouse.findFirst({ where: { isDefault: true } }))?.id;
  }
  if (!warehouseId) {
    warehouseId = (
      await db.warehouse.create({ data: { code: `w_${tag}`, name: `Depozit ${tag}` } })
    ).id;
    ownsWarehouse = true;
  }
  return {
    tag,
    warehouseId,
    unitId: unit.id,
    ownsWarehouse,
    productIds: [],
    variantIds: [],
    snapshotIds: [],
  };
}

export interface VariantSpec {
  /** Stocul fizic; `null` = fără rând de stoc (neinventariat) */
  physical?: string | null;
  buffer?: string;
}

export interface ProductSpec {
  /** Pasul de vânzare, ex. "0,3"; implicit o unitate */
  step?: string;
  minSteps?: number;
  type?: "physical" | "digital";
  manageStock?: boolean;
  stockStatus?: "instock" | "outofstock" | "onbackorder";
  allowBackorder?: boolean;
  /** Starea produsului; implicit cea din bază («draft»). «Anunță-mă» cere un produs «active». */
  status?: "draft" | "active" | "archived";
  variants?: readonly VariantSpec[];
}

export async function addStockProduct(
  db: Client,
  ctx: StockContext,
  spec: ProductSpec = {},
): Promise<{ productId: string; variants: Array<{ id: string; sku: string }> }> {
  const slug = `st-${ctx.tag}-${ctx.productIds.length}`;
  const hasStep = spec.step !== undefined;
  const product = await db.product.create({
    data: {
      slug,
      title: `Produs stoc ${slug}`,
      type: spec.type ?? "physical",
      manageStock: spec.manageStock ?? true,
      stockStatus: spec.stockStatus ?? "instock",
      allowBackorder: spec.allowBackorder ?? false,
      ...(spec.status !== undefined && { status: spec.status }),
      ...(hasStep && {
        measureUnitId: ctx.unitId,
        saleStep: saleStepToInt(parseQuantity(spec.step as string)),
      }),
      ...(spec.minSteps !== undefined && { minSteps: spec.minSteps }),
    },
  });
  ctx.productIds.push(product.id);
  const variants: Array<{ id: string; sku: string }> = [];
  for (const [index, variantSpec] of (spec.variants ?? [{ physical: "0" }]).entries()) {
    const sku = `ST-${ctx.tag}-${ctx.productIds.length - 1}-${index}`.toUpperCase();
    const variant = await db.productVariant.create({
      data: { productId: product.id, sku, price: 1000, position: index, isDefault: index === 0 },
    });
    ctx.variantIds.push(variant.id);
    variants.push({ id: variant.id, sku });
    if (variantSpec.physical !== null) {
      await db.inventoryItem.create({
        data: {
          variantId: variant.id,
          warehouseId: ctx.warehouseId,
          physical: parseQuantity(variantSpec.physical ?? "0"),
          safetyBuffer: parseQuantity(variantSpec.buffer ?? "0"),
        },
      });
    }
  }
  return { productId: product.id, variants };
}

interface PurgeTargets {
  variantIds: string[];
  productIds: string[];
  snapshotIds: string[];
  warehouseIds: string[];
  unitIds: string[];
}

/**
 * Garda curățării: refuză orice bază al cărei nume nu conține cuvântul «test» ca segment (`ecom_test`, `test`, `ecom-test-2`),
 * nu ca subșir (`contest`, `latest_orders`). Curățarea oprește un trigger de imuabilitate și șterge mișcări de stoc.
 */

export async function assertStockTestDatabase(db: PrismaClient): Promise<void> {
  const database = await db.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
  const name = database[0]?.name ?? "";
  if (!isTestDatabaseName(name)) {
    throw new Error(
      `REFUZ să șterg date de stoc pe baza «${name}»: numele ei nu conține «test» ca segment`,
    );
  }
}

async function purgeRows(db: PrismaClient, targets: PurgeTargets): Promise<void> {
  const { variantIds, productIds, snapshotIds, warehouseIds, unitIds } = targets;
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "stock_movement" DISABLE TRIGGER "stock_movement_no_update_delete"',
      );
      try {
        await tx.stockMovement.deleteMany({ where: { variantId: { in: variantIds } } });
      } finally {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "stock_movement" ENABLE TRIGGER "stock_movement_no_update_delete"',
        );
      }
      await tx.stockSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
      await tx.stockReservation.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.stockCommitment.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.backInStockAlert.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.productVariant.deleteMany({ where: { id: { in: variantIds } } });
      await tx.product.deleteMany({ where: { id: { in: productIds } } });
      await tx.stockSnapshot.deleteMany({ where: { warehouseId: { in: warehouseIds } } });
      await tx.warehouse.deleteMany({ where: { id: { in: warehouseIds } } });
      await tx.measureUnit.deleteMany({ where: { id: { in: unitIds } } });
    },
    { timeout: 30_000 },
  );
}

/** Șterge TOT ce a creat contextul, inclusiv mișcările imuabile. Doar pe baza de test. */
export async function purgeStockContext(db: PrismaClient, ctx: StockContext): Promise<void> {
  await assertStockTestDatabase(db);
  await purgeRows(db, {
    variantIds: ctx.variantIds,
    productIds: ctx.productIds,
    snapshotIds: ctx.snapshotIds,
    warehouseIds: ctx.ownsWarehouse ? [ctx.warehouseId] : [],
    unitIds: [ctx.unitId],
  });
}

/**
 * Șterge ce au lăsat în urmă contexte rămase la jumătate (test întrerupt, probă de mutație cu tranzacții blocate), DOAR din
 * spațiul de nume dat: produsele `st-<spațiu>_…`, depozitele `w_<spațiu>_…` și unitățile `u_<spațiu>_…`. Testele de concurență
 * lucrează cu date COMISE, iar testele altor fișiere (de exemplu exportul de produse) numără tot ce e în bază: un rest ar
 * strica rezultatul lor. Se apelează la începutul și la finalul fișierului, cu spațiul de nume al fișierului. O curățare globală
 * (toate `st-…`) ar șterge datele aflate în lucru ale altui fișier rulat în paralel (incidentul #2, 15e).
 */
export async function purgeStockLeftovers(db: PrismaClient, namespace: string): Promise<number> {
  assertStockNamespace(namespace);
  await assertStockTestDatabase(db);
  // `_` e metacaracter în LIKE (`fxone_%` ar potrivi și `fxonex…`): interogarea aduce un superset, iar prefixul exact se
  // verifică în cod, ca spațiile de nume care sunt prefix unul altuia să nu se atingă.
  const slugPrefix = `st-${namespace}_`;
  const warehousePrefix = `w_${namespace}_`;
  const unitPrefix = `u_${namespace}_`;
  const products = (
    await db.product.findMany({
      where: { slug: { startsWith: slugPrefix }, title: { startsWith: "Produs stoc " } },
      select: { id: true, slug: true, variants: { select: { id: true } } },
    })
  ).filter((product) => product.slug.startsWith(slugPrefix));
  const warehouses = (
    await db.warehouse.findMany({
      where: { code: { startsWith: warehousePrefix }, isDefault: false },
      select: { id: true, code: true },
    })
  ).filter((warehouse) => warehouse.code.startsWith(warehousePrefix));
  const units = (
    await db.measureUnit.findMany({
      where: { code: { startsWith: unitPrefix }, isSystem: false },
      select: { id: true, code: true },
    })
  ).filter((unit) => unit.code.startsWith(unitPrefix));
  if (products.length + warehouses.length + units.length === 0) return 0;
  await purgeRows(db, {
    variantIds: products.flatMap((p) => p.variants.map((v) => v.id)),
    productIds: products.map((p) => p.id),
    snapshotIds: [],
    warehouseIds: warehouses.map((w) => w.id),
    unitIds: units.map((u) => u.id),
  });
  return products.length;
}
