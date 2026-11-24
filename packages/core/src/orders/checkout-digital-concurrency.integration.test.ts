import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity } from "@ecom/shared";
import { CartService, type CartOwner, type CartRuntimeSettings } from "../cart/cart-service";
import { DIGITAL_CONSENT_DEFAULT_VERSION } from "../digital/digital-rules";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { DEFAULT_PALLET_SETTINGS } from "../shipping/pallet";
import { ShippingService, createPrismaShippingStore } from "../shipping/shipping-service";
import { CHECKOUT_SETTINGS } from "../test-utils/checkout-fixtures";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
} from "../test-utils/stock-fixtures";
import { CHECKOUT_TERMS_CONSENT } from "./consent";
import { CheckoutService } from "./checkout-service";
import { transitionOrder } from "./order-service";

/**
 * Faza 14c, concurența pe Postgres REAL, cu date COMISE și conexiuni separate (pool): două plasări simultane cu aceeași cheie de
 * idempotență dau o singură comandă; două plasări simultane pe același coș digital dau o singură comandă; confirmările de plată
 * simultane nu acordă accesul de două ori. Fișier propriu (datele comise nu se amestecă cu testele în tranzacție anulată); ce se
 * creează aici se șterge la sfârșit.
 */
const pool = getDb();
const STOCK_NAMESPACE = "chkdg";
const EMAIL = "concurenta-digital@exemplu.ro";

afterAll(async () => {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  await pool.$disconnect();
});

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 11).toString("base64")),
});
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

let sirutaSeq = 950_000;

async function withDigitalCart<T>(
  fn: (env: {
    checkout: CheckoutService;
    owner: CartOwner;
    userId: string;
    input: () => Record<string, unknown>;
    orders: () => Promise<Array<{ id: string }>>;
  }) => Promise<T>,
): Promise<T> {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  const ctx = await createStockContext(pool, { namespace: STOCK_NAMESPACE });
  const channelExisted = (await pool.salesChannel.findUnique({ where: { code: "web" } })) !== null;
  if (!channelExisted) {
    await pool.salesChannel.create({ data: { code: "web", name: "Web (test)", isSystem: false } });
  }
  const userId = `u_${randomUUID().replaceAll("-", "")}`;
  const sirutaCodes: number[] = [];
  try {
    const county = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 95,
        name: "JUDEȚUL DIGITAL",
        parentCode: null,
        tip: 40,
        level: 1,
        sourceVersion: "t",
      },
    });
    const uat = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 95,
        name: "COMUNA DIGITAL",
        parentCode: county.code,
        tip: 3,
        level: 2,
        sourceVersion: "t",
      },
    });
    const locality = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 95,
        name: "SAT DIGITAL",
        parentCode: uat.code,
        tip: 22,
        level: 3,
        sourceVersion: "t",
      },
    });
    sirutaCodes.push(locality.code, uat.code, county.code);
    await pool.user.create({
      data: {
        id: userId,
        name: "Client Concurență",
        email: `${userId}@exemplu.test`,
        emailVerified: true,
      },
    });

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
          pickupAddress: null,
          easyboxEnabled: false,
          quoteTimeoutMs: 2000,
          pallet: DEFAULT_PALLET_SETTINGS,
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

    const created = await addStockProduct(pool, ctx, {
      status: "active",
      type: "digital",
      manageStock: false,
      variants: [{ physical: null }],
    });
    const variantId = created.variants[0]!.id;
    await pool.productVariant.update({ where: { id: variantId }, data: { price: 30_000 } });
    const owner: CartOwner = { kind: "user", userId };
    await createCart(pool).add(owner, {
      variantId,
      quantity: parseQuantity("1", { maxDecimals: 4 }),
    });

    const input = () => ({
      idempotencyKey: randomUUID(),
      expectedTotalMinor: 30_000,
      contact: { email: EMAIL, phone: "0722123456" },
      billing: {
        sameAsShipping: false,
        address: {
          fullName: "Ion Popescu",
          phone: "0722123456",
          countyCode: 95,
          localityCode: locality.code,
          street: "Str. Facturii 1",
          postalCode: "123456",
        },
      },
      company: null,
      paymentMethod: "bank_transfer",
      consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
      digitalConsent: { accepted: true, version: DIGITAL_CONSENT_DEFAULT_VERSION },
    });
    const orders = () => pool.order.findMany({ where: { email: EMAIL }, select: { id: true } });
    return await fn({ checkout, owner, userId, input, orders });
  } finally {
    const rows = await pool.order.findMany({ where: { email: EMAIL }, select: { id: true } });
    await pool.cart.deleteMany({ where: { userId } });
    // drepturile, jurnalul și liniile se șterg în cascadă odată cu comanda; abia apoi produsele (drepturile le țineau cu RESTRICT)
    await pool.order.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    await purgeStockContext(pool, ctx);
    await pool.user.deleteMany({ where: { id: userId } });
    await pool.sirutaUnit.deleteMany({ where: { code: { in: sirutaCodes } } });
    await pool.sirutaUnit.deleteMany({ where: { countyCode: 95 } });
    if (!channelExisted) await pool.salesChannel.deleteMany({ where: { code: "web" } });
  }
}

const confirmPayment = (orderId: string) =>
  pool.$transaction((tx) =>
    transitionOrder(
      tx,
      orderId,
      { status: "confirmed", paymentStatus: "paid" },
      { type: "payment.confirmed", message: "plătită" },
      new Date(),
    ),
  );

describe("plasări simultane pe un coș digital", () => {
  it("aceeași cheie de idempotență, 6 cereri deodată: o singură comandă, toate întorc aceeași comandă", async () => {
    await withDigitalCart(async ({ checkout, owner, input, orders }) => {
      const same = input();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => checkout.place(owner, same)),
      );
      const ok = results.filter((result) => result.status === "fulfilled");
      expect(ok.length).toBeGreaterThanOrEqual(1);
      const ids = new Set(
        ok.map((result) => (result as PromiseFulfilledResult<{ orderId: string }>).value.orderId),
      );
      expect(ids.size).toBe(1);
      expect(await orders()).toHaveLength(1);
    });
  });

  it("chei diferite pe același coș, 5 cereri deodată: o singură comandă, restul refuzate; accesul se acordă o singură dată", async () => {
    await withDigitalCart(async ({ checkout, owner, input, orders }) => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => checkout.place(owner, input())),
      );
      const ok = results.filter((result) => result.status === "fulfilled");
      expect(ok).toHaveLength(1);
      for (const result of results.filter((r) => r.status === "rejected")) {
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          code: expect.stringMatching(/ORDER_CART_NOT_READY|ORDER_CART_CHANGED/),
        });
      }
      const [order] = await orders();
      expect(order).toBeDefined();
      const orderId = (ok[0] as PromiseFulfilledResult<{ orderId: string }>).value.orderId;
      expect(order?.id).toBe(orderId);

      // confirmări de plată simultane: un singur drept de acces pe linie
      await Promise.allSettled([1, 2, 3].map(() => confirmPayment(orderId)));
      const rows = await pool.digitalEntitlement.findMany({ where: { orderId } });
      expect(rows).toHaveLength(1);
    });
  });
});
