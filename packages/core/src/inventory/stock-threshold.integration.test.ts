import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 10a: pragul «stoc mic» pe variantă (`InventoryItem.lowStockSteps`, în pași), scris prin
 * `StockService.setLowStockSteps`, pe baza reală (tranzacție anulată). Testul nu presupune date de seed: depozitul implicit îl
 * creează `runBaseSeed` în propria tranzacție.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: StockService;
  product: (physical: string | null, spec?: ProductSpec) => Promise<{ id: string; sku: string }>;
  threshold: (variantId: string) => Promise<number | null | undefined>;
  counts: (variantId: string) => Promise<{ items: number; movements: number }>;
}

async function withStock<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const service = new StockService({ db: tx });
    return fn({
      tx,
      ctx,
      service,
      product: async (physical, spec = {}) => {
        const created = await addStockProduct(tx, ctx, { ...spec, variants: [{ physical }] });
        return created.variants[0]!;
      },
      threshold: async (variantId) =>
        (
          await tx.inventoryItem.findUnique({
            where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
            select: { lowStockSteps: true },
          })
        )?.lowStockSteps,
      counts: async (variantId) => ({
        items: await tx.inventoryItem.count({ where: { variantId } }),
        movements: await tx.stockMovement.count({ where: { variantId } }),
      }),
    });
  });
}

async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string };
  }
}

describe("setLowStockSteps: variantă gestionată cu rând de stoc", () => {
  it("setează pragul propriu, îl schimbă, îl pune pe 0 (valoare reală) și îl șterge (nul = setarea globală)", async () => {
    await withStock(async ({ service, product, threshold }) => {
      const v = await product("10");
      expect(await threshold(v.id)).toBeNull();

      const first = await service.setLowStockSteps({ variantId: v.id, steps: 5 });
      expect(first).toMatchObject({ variantId: v.id, before: null, after: 5 });
      expect(await threshold(v.id)).toBe(5);
      expect((await service.readInventory(v.id))?.lowStockSteps).toBe(5);

      const second = await service.setLowStockSteps({ variantId: v.id, steps: 0 });
      expect(second).toMatchObject({ before: 5, after: 0 });
      expect(await threshold(v.id)).toBe(0);

      const cleared = await service.setLowStockSteps({ variantId: v.id, steps: null });
      expect(cleared).toMatchObject({ before: 0, after: null });
      expect(await threshold(v.id)).toBeNull();
    });
  });

  it("aceeași valoare e un no-op raportat corect (înainte = după); depozitul explicit e același cu cel implicit", async () => {
    await withStock(async ({ service, product, ctx, threshold }) => {
      const v = await product("10");
      await service.setLowStockSteps({ variantId: v.id, steps: 3 });
      const again = await service.setLowStockSteps({
        variantId: v.id,
        warehouseId: ctx.warehouseId,
        steps: 3,
      });
      expect(again).toMatchObject({ warehouseId: ctx.warehouseId, before: 3, after: 3 });
      expect(await threshold(v.id)).toBe(3);
    });
  });

  it("nu atinge cantitățile și nu scrie în registrul imuabil de mișcări", async () => {
    await withStock(async ({ service, product, counts, tx, ctx }) => {
      const v = await product("12,5", { step: "2,5" });
      const before = await tx.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId: v.id, warehouseId: ctx.warehouseId } },
        select: { physical: true, committed: true, reserved: true, safetyBuffer: true },
      });
      const movementsBefore = (await counts(v.id)).movements;
      await service.setLowStockSteps({ variantId: v.id, steps: 4 });
      const after = await tx.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId: v.id, warehouseId: ctx.warehouseId } },
        select: { physical: true, committed: true, reserved: true, safetyBuffer: true },
      });
      expect(after).toEqual(before);
      expect((await counts(v.id)).movements).toBe(movementsBefore);
    });
  });
});

describe("setLowStockSteps: variantă gestionată fără rând de stoc (neinventariată)", () => {
  it("creează rândul (fizic 0, fără mișcare) ca pragul să se poată seta înainte de prima ajustare", async () => {
    await withStock(async ({ service, product, threshold, counts }) => {
      const v = await product(null);
      expect(await counts(v.id)).toEqual({ items: 0, movements: 0 });
      const result = await service.setLowStockSteps({ variantId: v.id, steps: 6 });
      expect(result).toMatchObject({ before: null, after: 6 });
      expect(await threshold(v.id)).toBe(6);
      expect(await counts(v.id)).toEqual({ items: 1, movements: 0 });
    });
  });
});

describe("setLowStockSteps: ștergerea unui prag care nu există", () => {
  it("la o variantă gestionată fără rând de stoc nu creează un rând doar ca să-l golească (înainte = după = nul)", async () => {
    await withStock(async ({ service, product, counts }) => {
      const v = await product(null);
      const result = await service.setLowStockSteps({ variantId: v.id, steps: null });
      expect(result).toMatchObject({ variantId: v.id, before: null, after: null });
      expect(await counts(v.id)).toEqual({ items: 0, movements: 0 });
    });
  });
});

describe("setLowStockSteps: ce nu se poate seta", () => {
  it("negestionat și digital: STOCK_NOT_MANAGED, fără rând de stoc creat", async () => {
    await withStock(async ({ service, product, counts }) => {
      const unmanaged = await product(null, { manageStock: false });
      const digital = await product(null, { type: "digital" });
      for (const v of [unmanaged, digital]) {
        const error = await failure(() => service.setLowStockSteps({ variantId: v.id, steps: 2 }));
        expect(error?.code, v.sku).toBe("STOCK_NOT_MANAGED");
        expect(await counts(v.id), v.sku).toEqual({ items: 0, movements: 0 });
      }
    });
  });

  it("bifa de pe variantă bate pe cea de pe produs, în ambele sensuri", async () => {
    await withStock(async ({ service, product, tx, threshold }) => {
      // produs gestionat, variantă coborâtă la negestionat → refuz
      const loweredVariant = await product("5");
      await tx.productVariant.update({
        where: { id: loweredVariant.id },
        data: { manageStock: false },
      });
      expect(
        (await failure(() => service.setLowStockSteps({ variantId: loweredVariant.id, steps: 2 })))
          ?.code,
      ).toBe("STOCK_NOT_MANAGED");
      expect(await threshold(loweredVariant.id)).toBeNull();
      // produs negestionat, variantă gestionată → permis
      const raisedVariant = await product(null, { manageStock: false });
      await tx.productVariant.update({
        where: { id: raisedVariant.id },
        data: { manageStock: true },
      });
      await service.setLowStockSteps({ variantId: raisedVariant.id, steps: 2 });
      expect(await threshold(raisedVariant.id)).toBe(2);
    });
  });

  it("variantă sau depozit inexistent: STOCK_VARIANT_NOT_FOUND / STOCK_NO_WAREHOUSE", async () => {
    await withStock(async ({ service, product }) => {
      expect(
        (await failure(() => service.setLowStockSteps({ variantId: "nu-exista", steps: 2 })))?.code,
      ).toBe("STOCK_VARIANT_NOT_FOUND");
      const v = await product("5");
      expect(
        (
          await failure(() =>
            service.setLowStockSteps({ variantId: v.id, warehouseId: "nu-exista", steps: 2 }),
          )
        )?.code,
      ).toBe("STOCK_NO_WAREHOUSE");
    });
  });

  it("pragul invalid se refuză și la nivelul serviciului (negativ, peste 1000, zecimal, NaN), fără să schimbe nimic", async () => {
    await withStock(async ({ service, product, threshold }) => {
      const v = await product("5");
      await service.setLowStockSteps({ variantId: v.id, steps: 3 });
      for (const steps of [-1, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const error = await failure(() => service.setLowStockSteps({ variantId: v.id, steps }));
        expect(error?.code, String(steps)).toBe("STOCK_THRESHOLD_INVALID");
        expect(await threshold(v.id), String(steps)).toBe(3);
      }
      // limitele în sine sunt valide
      for (const steps of [0, 1000]) {
        await service.setLowStockSteps({ variantId: v.id, steps });
        expect(await threshold(v.id)).toBe(steps);
      }
    });
  });
});

describe("pragul propriu schimbă ce e «stoc mic»", () => {
  it("cu pragul global 2, 3 pași nu sunt «stoc mic»; cu pragul propriu 3 sunt, iar cu 0 doar epuizarea contează", async () => {
    await withStock(async ({ service, product }) => {
      const { buildStockOverviewRow } = await import("./stock-overview");
      const v = await product("3");
      const rowFor = async () => {
        const inv = await service.readInventory(v.id);
        return buildStockOverviewRow(
          {
            variantId: v.id,
            sku: v.sku,
            variantLabel: null,
            productId: "p",
            productTitle: "P",
            productSlug: "p",
            productType: "physical",
            manageStock: true,
            stockStatus: "instock",
            allowBackorder: false,
            unit: { code: "buc", symbol: "buc", decimals: 0 },
            saleStep: 10000n,
            minSteps: null,
            item: inv && { ...inv, physicalAsOf: null },
            leadTime: { productDays: null, brandDays: null },
          },
          { defaultLowStockSteps: 2, defaultLeadTimeDays: 14 },
        );
      };
      expect((await rowFor()).lowStock).toBe(false);
      await service.setLowStockSteps({ variantId: v.id, steps: 3 });
      expect((await rowFor()).lowStock).toBe(true);
      await service.setLowStockSteps({ variantId: v.id, steps: 0 });
      expect((await rowFor()).lowStock).toBe(false);
      await service.setLowStockSteps({ variantId: v.id, steps: null });
      expect((await rowFor()).lowStock).toBe(false);
    });
  });
});
