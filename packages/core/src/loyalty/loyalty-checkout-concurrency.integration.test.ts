import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Prisma } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { CartService, type CartOwner, type CartRuntimeSettings } from "../cart/cart-service";
import { cancelOrder } from "../orders/order-actions";
import { confirmBankTransferPayment, expireDueTransferOrders } from "../orders/order-payments";
import { markOrderPickedUp } from "../orders/order-pickup";
import { LOYALTY_PORTS } from "../orders/order-service";
import { CheckoutService } from "../orders/checkout-service";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { DEFAULT_PALLET_SETTINGS } from "../shipping/pallet";
import { ShippingService, createPrismaShippingStore } from "../shipping/shipping-service";
import { CHECKOUT_SETTINGS } from "../test-utils/checkout-fixtures";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { adjustPoints, readBalance } from "./ledger";
import { grantDuePoints } from "./order-loyalty";

/**
 * Punctele la cereri SIMULTANE, cap-coadă, pe date COMISE și conexiuni separate (Faza 15b): aceleași puncte într-o singură
 * comandă, o singură acordare la două rulări ale jobului, puncte întoarse o singură dată la anulare simultană cu plata sau cu
 * expirarea. Setările programului sunt comise doar cât rulează fișierul (integrarea rulează fișierele pe rând) și revin exact
 * cum erau; datele proprii se șterg la final.
 */
const db = getDb();
const STOCK_NAMESPACE = "loycc";
const tag = randomUUID().slice(0, 8);
const COUNTY = 95;

const KEYS = ["loyalty.enabled", "loyalty.vatMode"] as const;
let savedSettings: Array<{ key: string; group: string; value: Prisma.JsonValue }> = [];
let savedFlag: boolean | null = null;
let channelExisted = true;
let ctx: StockContext;
let variantId = "";
let localityCode = 0;
const sirutaCodes: number[] = [];
const users: string[] = [];

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 5).toString("base64")),
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
const PICKUP = {
  street: "Strada Magazinului 7",
  city: "Alba Iulia",
  county: "Alba",
  postalCode: "510000",
  country: "RO",
};

const createCart = (client: typeof db) =>
  new CartService({
    db: client,
    storage,
    readSettings: async () => CART_SETTINGS,
    warehouseId: ctx.warehouseId,
  });

const checkoutService = () =>
  new CheckoutService({
    db,
    createCart: (client) => createCart(client as typeof db),
    shipping: new ShippingService({
      provider: new DemoShippingRateProvider(),
      store: createPrismaShippingStore(db),
      readSettings: async () => ({
        freeShippingThresholdMinor: null,
        freeShippingClasses: ["standard"],
        pickupEnabled: true,
        pickupAddress: PICKUP,
        easyboxEnabled: false,
        quoteTimeoutMs: 2000,
        pallet: DEFAULT_PALLET_SETTINGS,
      }),
    }),
    cui: { lookup: async () => ({ status: "unavailable", reason: "network" }) },
    warehouseId: ctx.warehouseId,
    readSettings: async () => ({
      ...CHECKOUT_SETTINGS,
      orderNumberPrefix: `L${tag}-`,
    }),
  });

beforeAll(async () => {
  await purgeStockLeftovers(db, STOCK_NAMESPACE);
  savedSettings = await db.setting.findMany({
    where: { key: { in: [...KEYS] } },
    select: { key: true, group: true, value: true },
  });
  savedFlag = (await db.featureFlag.findUnique({ where: { key: "loyalty" } }))?.enabled ?? null;
  await db.featureFlag.upsert({
    where: { key: "loyalty" },
    create: { key: "loyalty", enabled: true },
    update: { enabled: true },
  });
  for (const [key, value] of [
    ["loyalty.enabled", true],
    ["loyalty.vatMode", "base_reduced"],
  ] as const) {
    await db.setting.upsert({
      where: { key },
      create: { key, group: "loyalty", value },
      update: { value },
    });
  }
  channelExisted = (await db.salesChannel.findUnique({ where: { code: "web" } })) !== null;
  if (!channelExisted) {
    await db.salesChannel.create({ data: { code: "web", name: "Web (test)", isSystem: false } });
  }
  ctx = await createStockContext(db, { namespace: STOCK_NAMESPACE });
  const base = 945_000 + Math.floor(Math.random() * 4_000);
  const county = await db.sirutaUnit.create({
    data: {
      code: base,
      countyCode: COUNTY,
      name: "JUDEȚUL PUNCTE",
      parentCode: null,
      tip: 40,
      level: 1,
      sourceVersion: "t",
    },
  });
  const uat = await db.sirutaUnit.create({
    data: {
      code: base + 1,
      countyCode: COUNTY,
      name: "COMUNA PUNCTE",
      parentCode: county.code,
      tip: 3,
      level: 2,
      sourceVersion: "t",
    },
  });
  const locality = await db.sirutaUnit.create({
    data: {
      code: base + 2,
      countyCode: COUNTY,
      name: "SAT PUNCTE",
      parentCode: uat.code,
      tip: 22,
      level: 3,
      sourceVersion: "t",
    },
  });
  localityCode = locality.code;
  sirutaCodes.push(locality.code, uat.code, county.code);
  const created = await addStockProduct(db, ctx, {
    status: "active",
    variants: [{ physical: "500" }],
  });
  variantId = created.variants[0]!.id;
  await db.productVariant.update({
    where: { id: variantId },
    data: { price: 100_000, weightGrams: 1000, lengthMm: 100, widthMm: 100, heightMm: 100 },
  });
});

afterAll(async () => {
  const orders = await db.order.findMany({
    where: { loyaltyCustomerId: { in: users } },
    select: { id: true },
  });
  await db.cart.deleteMany({ where: { userId: { in: users } } });
  await purgeStockContext(db, ctx);
  await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await db.loyaltyAccount.deleteMany({ where: { customerId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.sirutaUnit.deleteMany({ where: { code: { in: sirutaCodes } } });
  if (!channelExisted) await db.salesChannel.deleteMany({ where: { code: "web" } });
  await db.setting.deleteMany({ where: { key: { in: [...KEYS] } } });
  for (const row of savedSettings) {
    await db.setting.create({
      data: { key: row.key, group: row.group, value: row.value ?? (null as never) },
    });
  }
  if (savedFlag === null) await db.featureFlag.deleteMany({ where: { key: "loyalty" } });
  else await db.featureFlag.update({ where: { key: "loyalty" }, data: { enabled: savedFlag } });
  await db.$disconnect();
});

async function buyer(points: number) {
  const id = `lcc_${tag}_${randomUUID().slice(0, 12)}`;
  await db.user.create({
    data: { id, name: "Concurență", email: `${id}@exemplu.test`, emailVerified: true },
  });
  users.push(id);
  if (points > 0) {
    await db.$transaction((tx) =>
      adjustPoints(tx, {
        customerId: id,
        points,
        reason: "puncte de test",
        actorId: "u_test",
        expiresAt: new Date(Date.now() + 200 * 86_400_000),
        now: new Date(),
        key: randomUUID(),
      }),
    );
  }
  const owner: CartOwner = { kind: "user", userId: id };
  await createCart(db).add(owner, { variantId, quantity: "minimum" });
  return { id, owner };
}

/** Intrarea de plasare cu ridicare personală și transfer bancar, cu `points` puncte folosite. */
async function inputFor(owner: CartOwner, points: number) {
  const checkout = checkoutService();
  const destination = { countyCode: COUNTY, localityCode, postalCode: "123456" };
  const first = await checkout.preview({ owner, destination, paymentMethod: "bank_transfer" });
  const offer = first.shipping!.offers.find((o) => o.kind === "pickup")!;
  const preview = await checkout.preview({
    owner,
    destination,
    offerCode: offer.code,
    paymentMethod: "bank_transfer",
    ...(points > 0 ? { loyaltyPoints: points } : {}),
  });
  return {
    idempotencyKey: randomUUID(),
    expectedTotalMinor: preview.totals!.totalMinor,
    contact: { email: `p-${tag}@exemplu.test`, phone: "0722123456" },
    shipping: {
      fullName: "Ion Popescu",
      phone: "0722123456",
      countyCode: COUNTY,
      localityCode,
      street: "Str. Exemplu 1",
      postalCode: "123456",
    },
    billing: { sameAsShipping: true },
    company: null,
    shippingOfferCode: offer.code,
    paymentMethod: "bank_transfer",
    consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
    ...(points > 0 ? { loyaltyPoints: points } : {}),
  };
}

const rowsOf = async (orderId: string, type: string) =>
  db.loyaltyTransaction.count({ where: { orderId, type } });

async function invariant(customerId: string): Promise<number> {
  const balance = await readBalance(db, customerId);
  const ledger = await db.loyaltyTransaction.aggregate({
    where: { customerId },
    _sum: { points: true },
  });
  const lots = await db.loyaltyLot.aggregate({ where: { customerId }, _sum: { remaining: true } });
  expect(ledger._sum.points ?? 0).toBe(balance);
  expect(lots._sum.remaining ?? 0).toBe(Math.max(balance, 0));
  return balance;
}

describe("două comenzi simultane cu aceleași puncte", () => {
  it("dublu clic cu chei diferite, ambele cer tot soldul: reușește EXACT una și punctele ies o singură dată", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { id, owner } = await buyer(100);
      const checkout = checkoutService();
      const [a, b] = [await inputFor(owner, 100), await inputFor(owner, 100)];
      const results = await Promise.allSettled([
        checkout.place(owner, a),
        checkout.place(owner, b),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await db.order.count({ where: { loyaltyCustomerId: id } })).toBe(1);
      expect(await invariant(id)).toBe(0);
    }
  });

  it("punctele cheltuite între timp (altă comandă a aceluiași cont): plasarea se anulează întreagă", async () => {
    const { id, owner } = await buyer(100);
    const input = await inputFor(owner, 100);
    const before = await db.stockReservation.count();
    // «cealaltă comandă» ia punctele după previzualizare
    await db.$transaction((tx) =>
      adjustPoints(tx, {
        customerId: id,
        points: -60,
        reason: "consum de test",
        actorId: "u_test",
        expiresAt: new Date(),
        now: new Date(),
        key: randomUUID(),
      }),
    );
    await expect(checkoutService().place(owner, input)).rejects.toMatchObject({
      code: "ORDER_POINTS_INVALID",
    });
    expect(await db.order.count({ where: { loyaltyCustomerId: id } })).toBe(0);
    expect(await db.stockReservation.count()).toBe(before);
    expect(await invariant(id)).toBe(40);
  });
});

async function placed(points: number, balance = 100) {
  const { id, owner } = await buyer(balance);
  const result = await checkoutService().place(owner, await inputFor(owner, points));
  return { customerId: id, orderId: result.orderId };
}

describe("punctele se întorc o singură dată", () => {
  const cancel = (orderId: string) =>
    cancelOrder(db, orderId, {
      reason: "anulare de test",
      actorLabel: "admin",
      now: new Date(),
      acknowledgePaid: true,
    });

  it("anulare simultană cu confirmarea plății", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { customerId, orderId } = await placed(100);
      await Promise.allSettled([
        cancel(orderId),
        confirmBankTransferPayment(db, orderId, { now: new Date() }),
      ]);
      const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
      const cancelled = order.status === "cancelled";
      expect(await rowsOf(orderId, "release")).toBe(cancelled ? 1 : 0);
      expect(await invariant(customerId)).toBe(cancelled ? 100 : 0);
    }
  });

  it("două anulări și expirarea termenului, toate deodată", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { customerId, orderId } = await placed(100);
      await Promise.allSettled([
        cancel(orderId),
        cancel(orderId),
        expireDueTransferOrders(db, { now: new Date(Date.now() + 40 * 86_400_000) }),
      ]);
      expect(await rowsOf(orderId, "release")).toBe(1);
      expect(await invariant(customerId)).toBe(100);
    }
  });
});

describe("jobul de acordare rulat de două ori deodată", () => {
  it("o singură acumulare pe comandă", async () => {
    const orders: Array<{ customerId: string; orderId: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      const order = await placed(0, 0);
      await confirmBankTransferPayment(db, order.orderId, { now: new Date() });
      await markOrderPickedUp(db, order.orderId, "admin", new Date());
      orders.push(order);
    }
    const due = new Date(Date.now() + 15 * 86_400_000);
    await Promise.all(
      Array.from({ length: 3 }, () => grantDuePoints(db, { now: due, ports: LOYALTY_PORTS })),
    );
    for (const order of orders) {
      expect(await rowsOf(order.orderId, "earn")).toBe(1);
      // 1.000,00 lei plătiți în bani → 10 puncte
      expect(await invariant(order.customerId)).toBe(10);
    }
  });
});
