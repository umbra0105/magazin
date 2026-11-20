import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { CartService, type CartRuntimeSettings } from "../cart/cart-service";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { CheckoutService } from "../orders/checkout-service";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { ShippingService, createPrismaShippingStore } from "../shipping/shipping-service";
import { CHECKOUT_SETTINGS } from "../test-utils/checkout-fixtures";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { OfferService, type OfferDraftInput } from "./offer-service";

/**
 * Oferta de plată la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool), pe Postgres real: două plăți deodată pe același
 * link dau o singură comandă, iar două oferte pentru ultima bucată din stoc dau o comandă și o ofertă «stale». Fișier propriu
 * (datele comise nu se amestecă cu testele în tranzacție anulată); datele se șterg la sfârșitul fiecărui test.
 */
const pool = getDb();
const STOCK_NAMESPACE = "offcc";
const EMAIL = "oferta-conc@exemplu.ro";

afterAll(async () => {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  await pool.$disconnect();
});

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 11).toString("base64")),
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
const CONSENT = { accepted: true as const, version: CHECKOUT_TERMS_CONSENT.version };
const ACTOR = { id: "user-cc", label: "Manager Test" };

let sirutaSeq = 950_000;

interface Env {
  ctx: StockContext;
  offers: OfferService;
  variant: (physical: string) => Promise<string>;
  draft: (variantId: string, quantity?: string) => OfferDraftInput;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  const ctx = await createStockContext(pool, { namespace: STOCK_NAMESPACE });
  const sirutaCodes: number[] = [];
  const channelExisted = (await pool.salesChannel.findUnique({ where: { code: "web" } })) !== null;
  if (!channelExisted) {
    await pool.salesChannel.create({ data: { code: "web", name: "Web (test)", isSystem: false } });
  }
  try {
    const county = await pool.sirutaUnit.create({
      data: {
        code: sirutaSeq++,
        countyCode: 95,
        name: "JUDEȚUL OFERTE",
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
        name: "COMUNA OFERTE",
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
        name: "SAT OFERTE",
        parentCode: uat.code,
        tip: 22,
        level: 3,
        sourceVersion: "t",
      },
    });
    sirutaCodes.push(locality.code, uat.code, county.code);

    const cart = new CartService({
      db: pool,
      storage,
      readSettings: async () => CART_SETTINGS,
      warehouseId: ctx.warehouseId,
    });
    const checkout = new CheckoutService({
      db: pool,
      createCart: (client) =>
        new CartService({
          db: client,
          storage,
          readSettings: async () => CART_SETTINGS,
          warehouseId: ctx.warehouseId,
        }),
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
        }),
      }),
      cui: { lookup: async () => ({ status: "unavailable", reason: "network" }) },
      warehouseId: ctx.warehouseId,
      readSettings: async () => ({
        ...CHECKOUT_SETTINGS,
        cardProvider: { code: "demo", mode: "demo" },
        orderNumberPrefix: "",
        orderNumberDigits: 1,
      }),
    });
    const offers = new OfferService({
      db: pool,
      cart,
      checkout,
      readSettings: async () => ({ validityHours: 72, numberPrefix: "OFCC-" }),
    });
    const env: Env = {
      ctx,
      offers,
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
      draft: (variantId, quantity = "1") => ({
        email: EMAIL,
        phone: "0722123456",
        shipping: {
          fullName: "Ion Popescu",
          phone: "0722123456",
          countyCode: 95,
          localityCode: locality.code,
          street: "Str. Exemplu 1",
          postalCode: "123456",
        },
        billing: { sameAsShipping: true },
        company: null,
        shippingOfferCode: "demo:courier",
        lines: [{ variantId, quantity }],
      }),
    };
    return await fn(env);
  } finally {
    const orders = await pool.order.findMany({ where: { email: EMAIL }, select: { id: true } });
    const offerRows = await pool.orderOffer.findMany({
      where: { email: EMAIL },
      select: { id: true },
    });
    // oferta referă comanda (RESTRICT): oferta se șterge întâi, apoi rezervările și comenzile
    await pool.adminNotification.deleteMany({
      where: { dedupKey: { in: offerRows.map((o) => `offer_stale:${o.id}`) } },
    });
    await pool.orderOffer.deleteMany({ where: { id: { in: offerRows.map((o) => o.id) } } });
    await pool.cart.deleteMany({
      where: { items: { some: { variantId: { in: ctx.variantIds } } } },
    });
    await purgeStockContext(pool, ctx);
    await pool.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await pool.sirutaUnit.deleteMany({ where: { code: { in: sirutaCodes } } });
    await pool.sirutaUnit.deleteMany({ where: { countyCode: 95 } });
    if (!channelExisted) await pool.salesChannel.deleteMany({ where: { code: "web" } });
  }
}

describe("oferta la cereri simultane", () => {
  it("6 plăți deodată pe același link: o singură comandă, o singură rezervare, oferta «converted»", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("10");
      const created = await env.offers.create(env.draft(variantId, "2"), ACTOR);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => env.offers.convert(created.token, CONSENT)),
      );
      const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      expect(new Set(ok.map((r) => r.orderId)).size).toBe(1);
      expect(ok.filter((r) => !r.replayed)).toHaveLength(1);

      expect(await pool.order.count({ where: { email: EMAIL } })).toBe(1);
      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.reserved).toBe(q("2"));
      const offer = await pool.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } });
      expect(offer).toMatchObject({ status: "converted", convertedOrderId: ok[0]!.orderId });
      expect(
        await pool.orderOfferEvent.count({
          where: { offerId: created.offerId, type: "offer.converted" },
        }),
      ).toBe(1);
      // niciun coș temporar nu rămâne
      expect(await pool.cart.count({ where: { items: { some: { variantId } } } })).toBe(0);
    });
  });

  it("două oferte pentru ultima bucată, plătite deodată: o comandă, cealaltă ofertă «stale» (stoc), stocul nu scade sub 0", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("1");
      const a = await env.offers.create(env.draft(variantId), ACTOR);
      const b = await env.offers.create(env.draft(variantId), ACTOR);

      const results = await Promise.allSettled([
        env.offers.convert(a.token, CONSENT),
        env.offers.convert(b.token, CONSENT),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "OFFER_STALE" });

      const offers = await pool.orderOffer.findMany({
        where: { id: { in: [a.offerId, b.offerId] } },
        select: { status: true, staleReason: true },
      });
      expect(offers.map((o) => o.status).sort()).toEqual(["converted", "stale"]);
      expect(offers.find((o) => o.status === "stale")?.staleReason).toBe("stock");
      const item = await pool.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: env.ctx.warehouseId } },
      });
      expect(item.physical - item.committed - item.reserved).toBe(0n);
      expect(await pool.order.count({ where: { email: EMAIL } })).toBe(1);
    });
  });
});
