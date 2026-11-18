import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { CartService, type CartOwner, type CartRuntimeSettings } from "./cart-service";

/**
 * Coșul la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool): operațiile pe același coș se serializează (blocare pe
 * rândul coșului), deci cantitățile se adună exact și plafoanele se respectă. Fișier propriu: testele cu tranzacție anulată și
 * cele cu date comise nu se amestecă. Datele se șterg la sfârșitul fiecărui test; resturile unei rulări întrerupte, la început.
 */
const pool = getDb();
const STOCK_NAMESPACE = "cartcc";

afterAll(async () => {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  await pool.$disconnect();
});

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 5).toString("base64")),
});
const q = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });

const SETTINGS: CartRuntimeSettings = {
  showSalePricing: false,
  taxStandardRate: 21,
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  guestCartDays: 30,
  userCartDays: 90,
  maxLines: 50,
  maxStepsPerLine: 1000,
  freeShippingThreshold: null,
};

async function withCommitted<T>(
  settings: Partial<CartRuntimeSettings>,
  fn: (env: {
    ctx: StockContext;
    service: CartService;
    variant: () => Promise<string>;
    user: () => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  const ctx = await createStockContext(pool, { namespace: STOCK_NAMESPACE });
  const userIds: string[] = [];
  try {
    const service = new CartService({
      db: pool,
      storage,
      readSettings: async () => ({ ...SETTINGS, ...settings }),
      // depozitul propriu al contextului: testul nu presupune seed (depozit implicit)
      warehouseId: ctx.warehouseId,
    });
    const variant = async () => {
      const created = await addStockProduct(pool, ctx, {
        status: "active",
        manageStock: false,
        variants: [{ physical: "0" }],
      });
      return created.variants[0]!.id;
    };
    const user = async () => {
      const id = `u_${randomUUID().slice(0, 12)}`;
      await pool.user.create({
        data: { id, name: "Client test", email: `${id}@test.invalid`, emailVerified: true },
      });
      userIds.push(id);
      return id;
    };
    return await fn({ ctx, service, variant, user });
  } finally {
    // coșurile de oaspete nu au cheie spre variantă; se șterg cele care au linii pe variantele de test
    await pool.cart.deleteMany({
      where: { items: { some: { variantId: { in: ctx.variantIds } } } },
    });
    await pool.cart.deleteMany({ where: { userId: { in: userIds } } });
    await purgeStockContext(pool, ctx);
    await pool.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "fără cod";

describe("cereri simultane pe coș (date comise, conexiuni separate)", () => {
  it("12 adăugări deodată ale aceleiași variante în același coș: toate se adună, nicio actualizare pierdută", async () => {
    await withCommitted({}, async ({ service, variant }) => {
      const variantId = await variant();
      const first = await service.add(
        { kind: "guest", token: null },
        { variantId, quantity: q("1") },
      );
      const owner: CartOwner = { kind: "guest", token: first.newToken };
      const results = await Promise.allSettled(
        Array.from({ length: 11 }, () => service.add(owner, { variantId, quantity: q("1") })),
      );
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      const view = await service.view(owner);
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]!.quantityTicks).toBe("120000"); // 12 unități
    });
  });

  it("plafonul pe linie rezistă la cereri simultane: cu plafon de 5, exact 5 reușesc, restul primesc CART_EXCEEDS_LIMIT", async () => {
    await withCommitted({ maxStepsPerLine: 5 }, async ({ service, variant }) => {
      const variantId = await variant();
      const first = await service.add(
        { kind: "guest", token: null },
        { variantId, quantity: q("1") },
      );
      const owner: CartOwner = { kind: "guest", token: first.newToken };
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => service.add(owner, { variantId, quantity: q("1") })),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(4); // 1 (prima) + 4 = 5
      expect(refused).toHaveLength(6);
      for (const r of refused)
        expect(codeOf((r as PromiseRejectedResult).reason)).toBe("CART_EXCEEDS_LIMIT");
      expect((await service.view(owner)).lines[0]!.quantityTicks).toBe("50000");
    });
  });

  it("primele adăugări simultane ale unui utilizator fără coș: un singur coș, cantitatea însumată exact", async () => {
    await withCommitted({}, async ({ service, variant, user }) => {
      const userId = await user();
      const variantId = await variant();
      const owner: CartOwner = { kind: "user", userId };
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => service.add(owner, { variantId, quantity: q("1") })),
      );
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await pool.cart.count({ where: { userId } })).toBe(1);
      expect((await service.view(owner)).lines[0]!.quantityTicks).toBe("80000");
    });
  });

  it("două îmbinări simultane ale aceluiași coș de oaspete: se îmbină o singură dată (cantitățile nu se dublează)", async () => {
    await withCommitted({}, async ({ service, variant, user }) => {
      const userId = await user();
      const variantId = await variant();
      const added = await service.add(
        { kind: "guest", token: null },
        { variantId, quantity: q("3") },
      );
      const results = await Promise.allSettled([
        service.mergeGuestIntoUser(added.newToken!, userId),
        service.mergeGuestIntoUser(added.newToken!, userId),
      ]);
      // nicio îmbinare nu eșuează: a doua găsește coșul dispărut și nu face nimic
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const merged = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.merged] : []));
      expect(merged.reduce((a, b) => a + b, 0)).toBe(1);
      const view = await service.view({ kind: "user", userId });
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]!.quantityTicks).toBe("30000");
    });
  });
});
