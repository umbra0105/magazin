import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { CartService, type CartOwner, type CartRuntimeSettings } from "../cart/cart-service";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { ShippingService, createPrismaShippingStore } from "../shipping/shipping-service";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { CHECKOUT_SETTINGS } from "../test-utils/checkout-fixtures";
import { CHECKOUT_TERMS_CONSENT } from "./consent";
import { CheckoutService } from "./checkout-service";

/**
 * Plasarea comenzilor la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool), pe Postgres real: nu se vinde mai mult
 * decât există, numerele de comandă sunt unice și FĂRĂ GOLURI, iar dublu-click-ul dă o singură comandă. Fișier propriu (datele
 * comise nu se amestecă cu testele în tranzacție anulată); datele se șterg la sfârșitul fiecărui test.
 */
const pool = getDb();
const STOCK_NAMESPACE = "chkcc";

afterAll(async () => {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  await pool.$disconnect();
});

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
});
const q = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });
const CART_SETTINGS: CartRuntimeSettings = {
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

let sirutaSeq = 940_000;

interface Env {
  ctx: StockContext;
  checkout: CheckoutService;
  cart: CartService;
  localityCode: number;
  variant: (physical: string) => Promise<string>;
  /** Un coș nou, cu un produs, și intrarea de plasare pentru el. */
  cartWith: (variantId: string) => Promise<{ owner: CartOwner; input: Record<string, unknown> }>;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  const ctx = await createStockContext(pool, { namespace: STOCK_NAMESPACE });
  const sirutaCodes: number[] = [];
  const orderIds: string[] = [];
  const channelExisted = (await pool.salesChannel.findUnique({ where: { code: "web" } })) !== null;
  if (!channelExisted) {
    await pool.salesChannel.create({ data: { code: "web", name: "Web (test)", isSystem: false } });
  }
  try {
    const county = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 96,
        name: "JUDEȚUL CONCURENȚĂ",
        parentCode: null,
        tip: 40,
        level: 1,
        sourceVersion: "t",
      },
    });
    const uat = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 96,
        name: "COMUNA CONCURENȚĂ",
        parentCode: county.code,
        tip: 3,
        level: 2,
        sourceVersion: "t",
      },
    });
    const locality = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 96,
        name: "SAT CONCURENȚĂ",
        parentCode: uat.code,
        tip: 22,
        level: 3,
        sourceVersion: "t",
      },
    });
    sirutaCodes.push(locality.code, uat.code, county.code);

    const createCart = (client: typeof pool) =>
      new CartService({
        db: client,
        storage,
        readSettings: async () => CART_SETTINGS,
        warehouseId: ctx.warehouseId,
      });
    const checkout = new CheckoutService({
      db: pool,
      createCart: (client) => createCart(client as typeof pool),
      shipping: new ShippingService({
        provider: new DemoShippingRateProvider(),
        store: createPrismaShippingStore(pool),
        readSettings: async () => ({
          freeShippingThresholdMinor: null,
          freeShippingClasses: ["standard"],
          pickupEnabled: false,
          easyboxEnabled: false,
          quoteTimeoutMs: 2000,
        }),
      }),
      cui: { lookup: async () => ({ status: "unavailable", reason: "network" }) },
      warehouseId: ctx.warehouseId,
      readSettings: async () => ({
        ...CHECKOUT_SETTINGS,
        orderNumberPrefix: "",
        orderNumberDigits: 1,
      }),
    });
    const cart = createCart(pool);
    const env: Env = {
      ctx,
      checkout,
      cart,
      localityCode: locality.code,
      variant: async (physical) => {
        const created = await addStockProduct(pool, ctx, {
          status: "active",
          variants: [{ physical }],
        });
        const id = created.variants[0]!.id;
        await pool.productVariant.update({
          where: { id },
          data: { price: 10_000, weightGrams: 1000, lengthMm: 100, widthMm: 100, heightMm: 100 },
        });
        return id;
      },
      cartWith: async (variantId) => {
        const mutation = await cart.add(
          { kind: "guest", token: null },
          { variantId, quantity: q("1") },
        );
        const owner: CartOwner = { kind: "guest", token: mutation.newToken };
        const destination = { countyCode: 96, localityCode: locality.code, postalCode: "123456" };
        const preview = await checkout.preview({
          owner,
          destination,
          offerCode: "demo:courier",
          paymentMethod: "cod",
        });
        return {
          owner,
          input: {
            idempotencyKey: randomUUID(),
            expectedTotalMinor: preview.totals!.totalMinor,
            contact: { email: "concurenta@exemplu.ro", phone: "0722123456" },
            shipping: {
              fullName: "Ion Popescu",
              phone: "0722123456",
              countyCode: 96,
              localityCode: locality.code,
              street: "Str. Exemplu 1",
              postalCode: "123456",
            },
            billing: { sameAsShipping: true },
            company: null,
            shippingOfferCode: "demo:courier",
            paymentMethod: "cod",
            consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
          },
        };
      },
    };
    const result = await fn(env);
    const rows = await pool.order.findMany({
      where: { email: "concurenta@exemplu.ro" },
      select: { id: true },
    });
    orderIds.push(...rows.map((r) => r.id));
    return result;
  } finally {
    const rows = await pool.order.findMany({
      where: { email: "concurenta@exemplu.ro" },
      select: { id: true },
    });
    orderIds.push(...rows.map((r) => r.id));
    await pool.cart.deleteMany({
      where: { items: { some: { variantId: { in: ctx.variantIds } } } },
    });
    // rezervările și angajările referă comanda (cheie străină): se șterg înaintea comenzilor, odată cu stocul de test
    await purgeStockContext(pool, ctx);
    await pool.order.deleteMany({ where: { id: { in: orderIds } } });
    await pool.sirutaUnit.deleteMany({ where: { code: { in: sirutaCodes } } });
    await pool.sirutaUnit.deleteMany({ where: { countyCode: 96 } });
    if (!channelExisted) await pool.salesChannel.deleteMany({ where: { code: "web" } });
  }
}

const counterValue = async (): Promise<number> =>
  (await pool.orderCounter.findUnique({ where: { id: "order" } }))?.lastValue ?? 0;

describe("plasări simultane", () => {
  it("stoc de 3 și 8 clienți deodată: exact 3 comenzi, restul refuzate, stocul nu scade sub 0", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("3");
      const carts = [];
      for (let i = 0; i < 8; i++) carts.push(await env.cartWith(variantId));
      const before = await counterValue();

      const results = await Promise.allSettled(
        carts.map(({ owner, input }) => env.checkout.place(owner, input)),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(3);
      expect(failed).toHaveLength(5);
      for (const r of failed) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: expect.stringMatching(/STOCK_INSUFFICIENT|ORDER_CART_CHANGED|ORDER_CART_NOT_READY/),
        });
      }

      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.committed).toBe(q("3"));
      expect(item.physical - item.committed - item.reserved).toBe(0n);
      // numere fără goluri: doar plasările reușite au consumat un număr
      expect((await counterValue()) - before).toBe(3);
      const numbers = ok
        .map((r) => Number((r as PromiseFulfilledResult<{ number: string }>).value.number))
        .sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(3);
      expect(numbers[2]! - numbers[0]!).toBe(2);
    });
  });

  it("10 comenzi deodată cu stoc suficient: 10 numere distincte și consecutive", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("100");
      const carts = [];
      for (let i = 0; i < 10; i++) carts.push(await env.cartWith(variantId));
      const before = await counterValue();
      const results = await Promise.all(
        carts.map(({ owner, input }) => env.checkout.place(owner, input)),
      );
      const numbers = results.map((r) => Number(r.number)).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(10);
      expect(numbers[9]! - numbers[0]!).toBe(9);
      expect((await counterValue()) - before).toBe(10);
      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.committed).toBe(q("10"));
    });
  });

  it("dublu-click: aceeași cheie trimisă de 6 ori deodată dă O SINGURĂ comandă", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("10");
      const { owner, input } = await env.cartWith(variantId);
      const before = await counterValue();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => env.checkout.place(owner, input)),
      );
      const values = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      // fiecare click primește ACEEAȘI comandă (una nouă, restul reluate): niciunul nu eșuează (serializare pe cheia de idempotență)
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(values).toHaveLength(6);
      expect(new Set(values.map((v) => v.orderId)).size).toBe(1);
      expect(values.filter((v) => !v.replayed)).toHaveLength(1);
      expect(values.filter((v) => v.replayed)).toHaveLength(5);
      expect((await counterValue()) - before).toBe(1);
      expect(
        await pool.order.count({ where: { idempotencyKey: input["idempotencyKey"] as string } }),
      ).toBe(1);
      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.committed).toBe(q("1"));
    });
  });

  it("transfer bancar: 5 clienți deodată pe stoc de 2 → exact 2 rezervări active", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("2");
      const carts = [];
      for (let i = 0; i < 5; i++) {
        const c = await env.cartWith(variantId);
        c.input["paymentMethod"] = "bank_transfer";
        const preview = await env.checkout.preview({
          owner: c.owner,
          destination: { countyCode: 96, localityCode: env.localityCode, postalCode: "123456" },
          offerCode: "demo:courier",
          paymentMethod: "bank_transfer",
        });
        c.input["expectedTotalMinor"] = preview.totals!.totalMinor;
        carts.push(c);
      }
      const results = await Promise.allSettled(
        carts.map(({ owner, input }) => env.checkout.place(owner, input)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.reserved).toBe(q("2"));
      expect(item.committed).toBe(0n);
      expect(await pool.stockReservation.count({ where: { variantId, status: "active" } })).toBe(2);
    });
  });
});
