import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity } from "@ecom/shared";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { BackInStockService, type BackInStockSettings } from "./back-in-stock";

/**
 * Faza 5, punctul 11a: «Anunță-mă» la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool). Într-un fișier propriu,
 * ca la stoc: testele cu tranzacție anulată și cele cu date comise nu se amestecă. Datele create se șterg la sfârșitul
 * fiecărui test; resturile unei rulări întrerupte, la începutul lui.
 */
const pool = getDb();

afterAll(async () => {
  await purgeStockLeftovers(pool);
  await pool.$disconnect();
});

const SETTINGS: BackInStockSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  maxPerEmail: 5,
  maxPerVariant: 4,
};

async function withCommitted<T>(
  fn: (env: {
    ctx: StockContext;
    service: BackInStockService;
    variant: (spec?: ProductSpec) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  await purgeStockLeftovers(pool);
  const ctx = await createStockContext(pool);
  try {
    const service = new BackInStockService({
      db: pool,
      readSettings: async () => SETTINGS,
      warehouseId: ctx.warehouseId,
    });
    const variant = async (spec: ProductSpec = {}) =>
      (
        await addStockProduct(pool, ctx, {
          status: "active",
          variants: [{ physical: "0" }],
          ...spec,
        })
      ).variants[0]!.id;
    return await fn({ ctx, service, variant });
  } finally {
    await purgeStockContext(pool, ctx);
  }
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "fără cod";

describe("cereri simultane (date comise, conexiuni separate)", () => {
  it("10 cereri deodată ale aceleiași adrese pentru aceeași variantă: un singur rând, toate răspund «registered»", async () => {
    await withCommitted(async ({ service, variant }) => {
      const id = await variant();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          service.subscribe({
            variantId: id,
            email: i % 2 === 0 ? "ana@exemplu.ro" : "ANA@Exemplu.ro",
          }),
        ),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(results.map((r) => (r.status === "fulfilled" ? r.value.status : "eroare"))).toEqual(
        Array(10).fill("registered"),
      );
      expect(await pool.backInStockAlert.count({ where: { variantId: id } })).toBe(1);
    });
  });

  it("plafonul pe adresă ține sub cereri simultane: 12 variante deodată, plafon 5 → exact 5 înregistrate, 7 refuzate", async () => {
    await withCommitted(async ({ service, variant }) => {
      // produsele se creează pe rând (sluguri după un contor); cererile pornesc apoi deodată
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(await variant());
      const results = await Promise.allSettled(
        ids.map((variantId) => service.subscribe({ variantId, email: "ana@exemplu.ro" })),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(5);
      expect(refused).toHaveLength(7);
      for (const r of refused) {
        expect(codeOf((r as PromiseRejectedResult).reason)).toBe("BACK_IN_STOCK_EMAIL_LIMIT");
      }
      expect(
        await pool.backInStockAlert.count({ where: { variantId: { in: ids }, notifiedAt: null } }),
      ).toBe(5);
    });
  });

  it("plafonul pe variantă ține sub cereri simultane: 12 adrese deodată, plafon 4 → exact 4 înregistrate, 8 refuzate", async () => {
    await withCommitted(async ({ service, variant }) => {
      const id = await variant();
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          service.subscribe({ variantId: id, email: `client${i}@exemplu.ro` }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      const refused = results.filter((r) => r.status === "rejected");
      expect(refused).toHaveLength(8);
      for (const r of refused) {
        expect(codeOf((r as PromiseRejectedResult).reason)).toBe("BACK_IN_STOCK_VARIANT_LIMIT");
      }
      expect(await pool.backInStockAlert.count({ where: { variantId: id } })).toBe(4);
    });
  });

  it("4 claim-uri deodată pe aceeași cerere: exact unul câștigă, ceilalți găsesc cererea luată", async () => {
    await withCommitted(async ({ service, variant, ctx }) => {
      const id = await variant();
      await service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      await pool.inventoryItem.update({
        where: { variantId_warehouseId: { variantId: id, warehouseId: ctx.warehouseId } },
        data: { physical: parseQuantity("5") },
      });
      const alert = await pool.backInStockAlert.findFirstOrThrow({ where: { variantId: id } });
      const results = await Promise.all(Array.from({ length: 4 }, () => service.claim(alert.id)));
      expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.status === "gone")).toHaveLength(3);
    });
  });

  it("release și o cerere nouă a aceleiași adrese deodată: rămâne o singură cerere în așteptare, fără erori", async () => {
    await withCommitted(async ({ service, variant, ctx }) => {
      const id = await variant();
      await service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      const where = { variantId_warehouseId: { variantId: id, warehouseId: ctx.warehouseId } };
      await pool.inventoryItem.update({ where, data: { physical: parseQuantity("5") } });
      const alert = await pool.backInStockAlert.findFirstOrThrow({ where: { variantId: id } });
      expect((await service.claim(alert.id)).status).toBe("claimed");
      await pool.inventoryItem.update({ where, data: { physical: parseQuantity("0") } });
      const results = await Promise.allSettled([
        service.release(alert.id),
        service.subscribe({ variantId: id, email: "ana@exemplu.ro" }),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(
        await pool.backInStockAlert.count({ where: { variantId: id, notifiedAt: null } }),
      ).toBe(1);
    });
  });
});
