import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  DEMO_SIGNATURE_HEADER,
  DemoPaymentProvider,
  LocalStorageDriver,
  buildDemoEvent,
  deriveSigningKey,
} from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { CartService, type CartOwner, type CartRuntimeSettings } from "../cart/cart-service";
import { CheckoutService } from "../orders/checkout-service";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { ShippingService, createPrismaShippingStore } from "../shipping/shipping-service";
import { StockService } from "../inventory/stock-service";
import { CHECKOUT_SETTINGS } from "../test-utils/checkout-fixtures";
import { SIGNING_KEY } from "../test-utils/payment-fixtures";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { CardPaymentService, expireDueCardOrders } from "./card-payment-service";
import { checkMoneyInvariant } from "./money-invariant";
import {
  ingestPaymentWebhook,
  processPaymentEvent,
  type PaymentProcessorDeps,
} from "./payment-processor";
import { requestRefund } from "./refund-service";

/**
 * Plățile la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool), pe Postgres real: același webhook de 3 ori în
 * paralel = un singur efect; webhook concurent cu jobul de expirare; două rambursări simultane nu depășesc suma; reîncercare
 * concurentă cu expirarea. Fișier propriu (datele comise nu se amestecă cu testele în tranzacție anulată).
 */
const pool = getDb();
const NAMESPACE = "paycc";
const EMAIL = "plati-concurenta@exemplu.ro";

afterAll(async () => {
  await purgeStockLeftovers(pool, NAMESPACE);
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

let sirutaSeq = 950_000;

interface Env {
  ctx: StockContext;
  deps: PaymentProcessorDeps;
  card: CardPaymentService;
  variant: (physical: string) => Promise<string>;
  /** Plasează o comandă cu card (DEMO) și întoarce comanda și tentativa. */
  cardOrder: (
    variantId: string,
  ) => Promise<{ orderId: string; paymentId: string; amountMinor: number }>;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  await purgeStockLeftovers(pool, NAMESPACE);
  const ctx = await createStockContext(pool, { namespace: NAMESPACE });
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
        name: "JUDEȚUL PLĂȚI",
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
        name: "COMUNA PLĂȚI",
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
        name: "SAT PLĂȚI",
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
        cardProvider: { code: "demo", mode: "demo" },
      }),
    });
    const cart = createCart(pool);
    const provider = new DemoPaymentProvider({
      env: { E2E_HARNESS: "1" },
      signingKey: SIGNING_KEY,
    });
    const deps: PaymentProcessorDeps = {
      db: pool,
      getProvider: async (code) => (code === "demo" ? provider : null),
      now: () => new Date(),
    };
    const card = new CardPaymentService({
      db: pool,
      getProvider: async () => provider,
      readSettings: async () => ({
        reservationMinutes: 15,
        transferReservationWorkdays: 3,
        timeZone: "Europe/Bucharest",
        nonWorkingDates: [],
        cardRetryHours: 24,
        cardProvider: { code: "demo", mode: "demo" },
      }),
      now: () => new Date(),
      returnUrl: (id) => `https://magazin.test/comanda/plata/${id}`,
      notifyUrl: (p) => `https://magazin.test/api/webhooks/payments/${p}`,
    });
    const env: Env = {
      ctx,
      deps,
      card,
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
      cardOrder: async (variantId) => {
        const mutation = await cart.add(
          { kind: "guest", token: null },
          { variantId, quantity: q("1") },
        );
        const owner: CartOwner = { kind: "guest", token: mutation.newToken };
        const preview = await checkout.preview({
          owner,
          destination: { countyCode: 95, localityCode: locality.code, postalCode: "123456" },
          offerCode: "demo:courier",
          paymentMethod: "card",
        });
        const result = await checkout.place(owner, {
          idempotencyKey: randomUUID(),
          expectedTotalMinor: preview.totals!.totalMinor,
          contact: { email: EMAIL, phone: "0722123456" },
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
          paymentMethod: "card",
          consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
        });
        return {
          orderId: result.orderId,
          paymentId: result.paymentId!,
          amountMinor: preview.totals!.totalMinor,
        };
      },
    };
    return await fn(env);
  } finally {
    const orders = await pool.order.findMany({ where: { email: EMAIL }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await pool.cart.deleteMany({
      where: { items: { some: { variantId: { in: ctx.variantIds } } } },
    });
    await pool.refund.deleteMany({ where: { orderId: { in: ids } } });
    await pool.paymentWebhookEvent.deleteMany({ where: { payment: { orderId: { in: ids } } } });
    await purgeStockContext(pool, ctx);
    await pool.order.deleteMany({ where: { id: { in: ids } } });
    await pool.sirutaUnit.deleteMany({ where: { code: { in: sirutaCodes } } });
    await pool.sirutaUnit.deleteMany({ where: { countyCode: 95 } });
    if (!channelExisted) await pool.salesChannel.deleteMany({ where: { code: "web" } });
  }
}

let seq = 0;
const eventFor = (paymentId: string, amountMinor: number, id = `cc-${Date.now()}-${++seq}`) =>
  buildDemoEvent(
    {
      eventId: id,
      paymentRef: paymentId,
      outcome: "paid",
      amountMinor,
      currency: "RON",
      cardLast4: "4242",
    },
    SIGNING_KEY,
  );

async function deliver(env: Env, paymentId: string, amountMinor: number, eventId?: string) {
  const { rawBody, signature } = eventFor(paymentId, amountMinor, eventId);
  const ingest = await ingestPaymentWebhook(env.deps, "demo", {
    headers: { [DEMO_SIGNATURE_HEADER]: signature },
    rawBody,
  });
  if (ingest.eventId) await processPaymentEvent(env.deps, ingest.eventId);
  return ingest;
}

async function snapshot(orderId: string) {
  const order = await pool.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      events: true,
      payments: true,
      stockCommitments: true,
      stockReservations: true,
      refunds: true,
    },
  });
  return order;
}

describe("webhook simultan: un singur efect", () => {
  it("același eveniment de 3 ori în paralel = o confirmare, o angajare, un OrderEvent, zero rambursări", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("5");
      const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
      const id = `same-${randomUUID()}`;
      const results = await Promise.all(
        [1, 2, 3].map(() => deliver(env, paymentId, amountMinor, id)),
      );
      expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
      const order = await snapshot(orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.events.filter((e) => e.type === "payment.confirmed")).toHaveLength(1);
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.refunds).toHaveLength(0);
      const events = await pool.paymentWebhookEvent.count({
        where: { provider: "demo", eventId: id },
      });
      expect(events).toBe(1);
      const item = await pool.inventoryItem.findFirstOrThrow({ where: { variantId } });
      expect(item.committed).toBe(q("1"));
      expect(item.reserved).toBe(0n);
    });
  });

  it("trei evenimente DIFERITE pentru aceeași plată, în paralel = tot un singur efect", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("5");
      const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
      await Promise.all([1, 2, 3].map(() => deliver(env, paymentId, amountMinor)));
      const order = await snapshot(orderId);
      expect(order.events.filter((e) => e.type === "payment.confirmed")).toHaveLength(1);
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.refunds).toHaveLength(0);
      expect(await checkMoneyInvariant(pool, paymentId)).toBe("confirmed");
    });
  });

  it("plată târzie fără stoc, webhook ×3 în paralel = o singură rambursare", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("1");
      const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
      // rezervarea expiră și altcineva ia ultima bucată
      const later = () => new Date(Date.now() + 3_600_000);
      await new StockService({ db: pool, now: later }).expireDue();
      await new StockService({ db: pool, now: later }).commitDirect(
        { refType: "test", refId: `other-${randomUUID()}` },
        [{ variantId, warehouseId: env.ctx.warehouseId, quantity: q("1") }],
      );
      await Promise.all([1, 2, 3].map(() => deliver(env, paymentId, amountMinor, undefined)));
      const order = await snapshot(orderId);
      expect(order).toMatchObject({ status: "cancelled" });
      expect(order.refunds).toHaveLength(1);
      expect(order.events.filter((e) => e.type === "payment.stock_lost")).toHaveLength(1);
      expect(order.stockCommitments).toHaveLength(0);
      expect(await checkMoneyInvariant(pool, paymentId)).toBe("refunded");
      await pool.stockCommitment.deleteMany({ where: { refType: "test" } });
    });
  });
});

describe("webhook concurent cu jobul de expirare", () => {
  it("indiferent cine câștigă, plata are stare și nu apar efecte duble (8 încercări)", async () => {
    await withEnv(async (env) => {
      for (let i = 0; i < 8; i++) {
        const variantId = await env.variant("3");
        const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
        // fereastra de reîncercare a trecut și tentativa nu mai e «recentă»
        const past = new Date(Date.now() - 2 * 3_600_000);
        await pool.order.update({
          where: { id: orderId },
          data: { paymentRetryDeadlineAt: new Date(Date.now() - 60_000) },
        });
        await pool.payment.update({ where: { id: paymentId }, data: { createdAt: past } });
        const delay = i % 2 === 0;
        const [, expired] = await Promise.all([
          deliver(env, paymentId, amountMinor),
          (async () => {
            if (delay) await new Promise((r) => setTimeout(r, i));
            return expireDueCardOrders(pool, { now: new Date() });
          })(),
        ]);
        void expired;
        const order = await snapshot(orderId);
        const state = await checkMoneyInvariant(pool, paymentId);
        expect(state, `încercarea ${i}`).not.toBe("violation");
        if (order.status === "confirmed") {
          expect(order.stockCommitments).toHaveLength(1);
          expect(order.refunds).toHaveLength(0);
        } else {
          expect(order.status).toBe("cancelled");
          expect(order.stockCommitments).toHaveLength(0);
          expect(order.refunds).toHaveLength(1);
          expect(order.refunds[0]?.status).toBe("confirmed");
        }
        expect(
          order.events.filter((e) => e.type === "payment.confirmed").length,
        ).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe("rambursări simultane", () => {
  it("două rambursări de 60% din plată, în același timp: una trece, una e refuzată; suma angajată ≤ încasat", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("5");
      const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
      await deliver(env, paymentId, amountMinor);
      const part = Math.floor(amountMinor * 0.6);
      const refundDeps = { db: pool, getProvider: env.deps.getProvider, now: () => new Date() };
      const results = await Promise.allSettled(
        [1, 2].map((n) =>
          requestRefund(refundDeps, {
            paymentId,
            amountMinor: part,
            reason: "Test concurență",
            idempotencyKey: `cc-refund-${randomUUID()}-${n}`,
            actorLabel: "test",
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "REFUND_EXCEEDS_PAID" });
      const payment = await pool.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.refundCommittedMinor).toBe(part);
      const order = await snapshot(orderId);
      expect(order.refunds).toHaveLength(1);
      expect(order.paymentStatus).toBe("partially_refunded");
    });
  });

  it("aceeași cheie de idempotență de două ori în paralel = o singură rambursare", async () => {
    await withEnv(async (env) => {
      const variantId = await env.variant("5");
      const { orderId, paymentId, amountMinor } = await env.cardOrder(variantId);
      await deliver(env, paymentId, amountMinor);
      const refundDeps = { db: pool, getProvider: env.deps.getProvider, now: () => new Date() };
      const key = `cc-same-${randomUUID()}`;
      const results = await Promise.all(
        [1, 2].map(() =>
          requestRefund(refundDeps, {
            paymentId,
            amountMinor: 1_000,
            reason: "Test idempotență",
            idempotencyKey: key,
            actorLabel: "test",
          }),
        ),
      );
      expect(results.map((r) => r.created).sort()).toEqual([false, true]);
      expect((await snapshot(orderId)).refunds).toHaveLength(1);
      expect(
        (await pool.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundCommittedMinor,
      ).toBe(1_000);
    });
  });
});

describe("reîncercare concurentă cu expirarea", () => {
  it("rezultatul e coerent: ori comanda e anulată fără rezervări active, ori are o tentativă nouă cu rezervare activă (6 încercări)", async () => {
    await withEnv(async (env) => {
      for (let i = 0; i < 6; i++) {
        const variantId = await env.variant("3");
        const { orderId, paymentId } = await env.cardOrder(variantId);
        await pool.payment.update({
          where: { id: paymentId },
          data: {
            status: "failed",
            failureCode: "test",
            createdAt: new Date(Date.now() - 3_600_000),
          },
        });
        const { token } = await env.card.issueRetryToken(orderId);
        await pool.order.update({
          where: { id: orderId },
          data: { paymentRetryDeadlineAt: new Date(Date.now() + 150) },
        });
        await new Promise((r) => setTimeout(r, 100 + i * 10));
        const [retry] = await Promise.allSettled([
          env.card.startRetry(token),
          expireDueCardOrders(pool, { now: new Date(Date.now() + 200) }),
        ]);
        const order = await snapshot(orderId);
        const active = order.stockReservations.filter((r) => r.status === "active");
        if (order.status === "cancelled") {
          expect(active, `încercarea ${i}`).toHaveLength(0);
          expect(order.payments.filter((p) => p.status === "pending")).toHaveLength(0);
        } else {
          expect(order.status).toBe("pending");
          if (retry.status === "fulfilled") expect(active).toHaveLength(1);
        }
      }
    });
  });
});
