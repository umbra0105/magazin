import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity } from "@ecom/shared";
import { CartService, type CartRuntimeSettings } from "../cart/cart-service";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
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
import { cancelOrder } from "./order-actions";
import { markBankTransferPaid } from "./order-payments-admin";

/**
 * Regresie (Faza 11): după «Marchează plătit» dintr-o tranzacție, următoarea plasare de comandă pica cu «Transaction already
 * closed». Cauza era confirmarea de transfer pornită ÎN tranzacția adminului cu încă o treaptă de `inTx` (tranzacție imbricată pe un
 * client de tranzacție); acum «Marchează plătit» folosește `confirmBankTransferPaymentInTx`. Test pe date COMISE și clientul real
 * (nu pe tranzacția anulată a testelor obișnuite, care ascunde problema); datele se șterg la sfârșit.
 */
const pool = getDb();
const STOCK_NAMESPACE = "mpaid";
const EMAIL = "marcat-platit@exemplu.ro";

afterAll(async () => {
  await purgeStockLeftovers(pool, STOCK_NAMESPACE);
  await pool.$disconnect();
});

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 13).toString("base64")),
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

describe("«Marchează plătit» nu strică tranzacțiile următoare", () => {
  it.each(["marchează plătit", "anulează"] as const)(
    "o comandă cu transfer: %s, apoi o altă comandă se plasează",
    async (action) => {
      await purgeStockLeftovers(pool, STOCK_NAMESPACE);
      const ctx = await createStockContext(pool, { namespace: STOCK_NAMESPACE });
      const channelExisted =
        (await pool.salesChannel.findUnique({ where: { code: "web" } })) !== null;
      if (!channelExisted) {
        await pool.salesChannel.create({
          data: { code: "web", name: "Web (test)", isSystem: false },
        });
      }
      const county = await pool.sirutaUnit.create({
        data: {
          code: 960_001,
          countyCode: 94,
          name: "JUDEȚUL MARCAT",
          parentCode: null,
          tip: 40,
          level: 1,
          sourceVersion: "t",
        },
      });
      const uat = await pool.sirutaUnit.create({
        data: {
          code: 960_002,
          countyCode: 94,
          name: "COMUNA MARCAT",
          parentCode: county.code,
          tip: 3,
          level: 2,
          sourceVersion: "t",
        },
      });
      const locality = await pool.sirutaUnit.create({
        data: {
          code: 960_003,
          countyCode: 94,
          name: "SAT MARCAT",
          parentCode: uat.code,
          tip: 22,
          level: 3,
          sourceVersion: "t",
        },
      });
      try {
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
          variants: [{ physical: "10" }],
        });
        const variantId = created.variants[0]!.id;
        await pool.productVariant.update({
          where: { id: variantId },
          data: { price: 10_000, weightGrams: 1000, lengthMm: 100, widthMm: 100, heightMm: 100 },
        });

        const place = async () => {
          const cart = createCart(pool);
          const mutation = await cart.add(
            { kind: "guest", token: null },
            { variantId, quantity: parseQuantity("1", { maxDecimals: 4 }) },
          );
          const owner = { kind: "guest" as const, token: mutation.newToken };
          const preview = await checkout.preview({
            owner,
            destination: { countyCode: 94, localityCode: locality.code, postalCode: "123456" },
            offerCode: "demo:courier",
            paymentMethod: "bank_transfer",
          });
          return checkout.place(owner, {
            idempotencyKey: randomUUID(),
            expectedTotalMinor: preview.totals!.totalMinor,
            contact: { email: EMAIL, phone: "0722123456" },
            shipping: {
              fullName: "Ion Popescu",
              phone: "0722123456",
              countyCode: 94,
              localityCode: locality.code,
              street: "Str. Exemplu 1",
              postalCode: "123456",
            },
            billing: { sameAsShipping: true },
            company: null,
            shippingOfferCode: "demo:courier",
            paymentMethod: "bank_transfer",
            consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
          });
        };

        const first = await place();
        if (action === "anulează") {
          await cancelOrder(pool, first.orderId, {
            reason: "Test de regresie",
            acknowledgePaid: false,
            actorLabel: "test",
            now: new Date(),
          });
        } else {
          await markBankTransferPaid(pool, first.orderId, {
            amountMinor: (await pool.order.findUniqueOrThrow({ where: { id: first.orderId } }))
              .totalMinor,
            reference: "OP 123",
            acceptDifference: false,
            actorLabel: "test",
            now: new Date(),
          });
        }
        const second = await place();
        expect(second.orderId).not.toBe(first.orderId);
        expect((await pool.order.findUniqueOrThrow({ where: { id: first.orderId } })).status).toBe(
          action === "anulează" ? "cancelled" : "confirmed",
        );
      } finally {
        const orders = await pool.order.findMany({ where: { email: EMAIL }, select: { id: true } });
        await pool.cart.deleteMany({
          where: { items: { some: { variantId: { in: ctx.variantIds } } } },
        });
        await purgeStockContext(pool, ctx);
        await pool.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
        await pool.sirutaUnit.deleteMany({
          where: { code: { in: [locality.code, uat.code, county.code] } },
        });
        if (!channelExisted) await pool.salesChannel.deleteMany({ where: { code: "web" } });
      }
    },
  );
});
