import { randomUUID } from "node:crypto";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { CartService, type CartOwner, type CartRuntimeSettings } from "../cart/cart-service";
import { runBaseSeed } from "../seed/base-seed";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import { DEFAULT_PALLET_SETTINGS } from "../shipping/pallet";
import {
  ShippingService,
  createPrismaShippingStore,
  type ShippingRuntimeSettings,
} from "../shipping/shipping-service";
import type { ShippingRateProvider } from "../shipping/types";
import { inRolledBackTransaction, type TestTx } from "./rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "./stock-fixtures";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { CheckoutService, type CheckoutSettings } from "../orders/checkout-service";

/**
 * Fixture-uri comune ale testelor de checkout, comenzi, plăți și expirare: un coș cu produse reale într-o tranzacție ANULATĂ,
 * cu ceas injectat. Nu presupun seed (depozitul, canalul «web» și unitățile vin din `runBaseSeed` și din fixture-uri).
 */
const db = getDb();

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 7).toString("base64")),
});
export const NOW = new Date("2030-06-15T12:00:00.000Z");
export const q = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });

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

export const CHECKOUT_SETTINGS: CheckoutSettings = {
  taxStandardRate: 21,
  allowedCountries: ["RO"],
  timeZone: "Europe/Bucharest",
  nonWorkingDates: [],
  reservationMinutes: 15,
  transferReservationWorkdays: 3,
  orderNumberPrefix: "T-",
  orderNumberDigits: 4,
  codMaxIndividualMinor: 1_000_000,
  codMaxCompanyMinor: 500_000,
  bankDetailsConfigured: true,
  guestCheckoutEnabled: true,
  cardProvider: null,
  cardRetryHours: 24,
};

const SHIPPING_SETTINGS: ShippingRuntimeSettings = {
  freeShippingThresholdMinor: null,
  freeShippingClasses: ["standard"],
  pickupEnabled: true,
  // adresa FICTIVĂ a magazinului (`company.address`): ridicarea se oferă doar cu adresă completă
  pickupAddress: {
    street: "Strada Magazinului 7",
    city: "Alba Iulia",
    county: "Alba",
    postalCode: "510000",
    country: "RO",
  },
  easyboxEnabled: false,
  quoteTimeoutMs: 1000,
  pallet: DEFAULT_PALLET_SETTINGS,
};

interface ProductOpts extends ProductSpec {
  price?: number;
  shippingClass?: "standard" | "oversized" | "pallet";
  weightGrams?: number | null;
  physical?: string;
}

export interface Geo {
  countyCode: number;
  localityCode: number;
  otherLocalityCode: number;
}

let geoSeq = 930_000;
async function createGeo(tx: TestTx): Promise<Geo> {
  const county = await tx.sirutaUnit.create({
    data: {
      code: geoSeq++,
      countyCode: 98,
      name: "JUDEȚUL TEST",
      parentCode: null,
      tip: 40,
      level: 1,
      sourceVersion: "t",
    },
  });
  const uat = await tx.sirutaUnit.create({
    data: {
      code: geoSeq++,
      countyCode: 98,
      name: "COMUNA TEST",
      parentCode: county.code,
      tip: 3,
      level: 2,
      sourceVersion: "t",
    },
  });
  const locality = await tx.sirutaUnit.create({
    data: {
      code: geoSeq++,
      countyCode: 98,
      name: "SAT TEST",
      parentCode: uat.code,
      tip: 22,
      level: 3,
      sourceVersion: "t",
    },
  });
  const other = await tx.sirutaUnit.create({
    data: {
      code: geoSeq++,
      countyCode: 98,
      name: "ALT SAT",
      parentCode: uat.code,
      tip: 23,
      level: 3,
      sourceVersion: "t",
    },
  });
  return { countyCode: 98, localityCode: locality.code, otherLocalityCode: other.code };
}

export interface Harness {
  tx: TestTx;
  ctx: StockContext;
  geo: Geo;
  cart: CartService;
  checkout: CheckoutService;
  settings: CheckoutSettings;
  /** Setările de livrare citite de serviciu la fiecare cerere: un test le poate schimba între cereri. */
  shippingSettings: ShippingRuntimeSettings;
  product: (opts?: ProductOpts) => Promise<{ variantId: string; productId: string; sku: string }>;
  fill: (
    items: Array<{ variantId: string; quantity?: Quantity | "minimum" }>,
  ) => Promise<CartOwner>;
  input: (owner: CartOwner, over?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export async function harness<T>(
  fn: (h: Harness) => Promise<T>,
  over: {
    settings?: Partial<CheckoutSettings>;
    shipping?: Partial<ShippingRuntimeSettings>;
    /** Setările coșului (de exemplu promoția activă sau pragul de transport gratuit), peste cele implicite. */
    cart?: Partial<CartRuntimeSettings>;
    provider?: ShippingRateProvider;
    cui?: (cui: string) => Promise<unknown>;
  } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const geo = await createGeo(tx);
    const settings = { ...CHECKOUT_SETTINGS, ...over.settings };
    const shippingSettings: ShippingRuntimeSettings = { ...SHIPPING_SETTINGS, ...over.shipping };
    const createCart = (client: typeof tx) =>
      new CartService({
        db: client,
        storage,
        readSettings: async () => ({ ...CART_SETTINGS, ...over.cart }),
        now: () => NOW,
        warehouseId: ctx.warehouseId,
      });
    const shipping = new ShippingService({
      provider: over.provider ?? new DemoShippingRateProvider(),
      store: createPrismaShippingStore(tx),
      readSettings: async () => shippingSettings,
    });
    const checkout = new CheckoutService({
      db: tx,
      createCart: (client) => createCart(client as typeof tx),
      shipping,
      cui: {
        lookup: (async (cui: string) =>
          over.cui
            ? over.cui(cui)
            : {
                status: "found",
                name: "FIRMA TEST SRL",
                address: "Str. Firmei 1",
                tradeRegisterNo: "J01/1/2020",
              }) as never,
      },
      readSettings: async () => settings,
      now: () => NOW,
    });
    const cart = createCart(tx);
    const h: Harness = {
      tx,
      ctx,
      geo,
      cart,
      checkout,
      settings,
      shippingSettings,
      product: async (opts = {}) => {
        const { price, shippingClass, weightGrams, physical, ...spec } = opts;
        const created = await addStockProduct(tx, ctx, {
          status: "active",
          variants: [{ physical: physical ?? "100" }],
          ...spec,
        });
        const variant = created.variants[0]!;
        await tx.productVariant.update({
          where: { id: variant.id },
          data: {
            price: price ?? 19_900,
            weightGrams: weightGrams === undefined ? 2_000 : weightGrams,
            lengthMm: 200,
            widthMm: 200,
            heightMm: 200,
          },
        });
        if (shippingClass) {
          await tx.product.update({ where: { id: created.productId }, data: { shippingClass } });
        }
        return { variantId: variant.id, productId: created.productId, sku: variant.sku };
      },
      fill: async (items) => {
        let owner: CartOwner = { kind: "guest", token: null };
        for (const item of items) {
          const mutation = await cart.add(owner, {
            variantId: item.variantId,
            quantity: item.quantity ?? "minimum",
          });
          if (mutation.newToken) owner = { kind: "guest", token: mutation.newToken };
        }
        return owner;
      },
      input: async (owner, extra = {}) => {
        const merged: Record<string, unknown> = {
          idempotencyKey: randomUUID(),
          contact: { email: "Client@Exemplu.RO", phone: "0722 123 456" },
          shipping: {
            fullName: "Ion Popescu",
            phone: "0722123456",
            countyCode: geo.countyCode,
            localityCode: geo.localityCode,
            street: "Str. Exemplu 1",
            postalCode: "123456",
          },
          billing: { sameAsShipping: true },
          company: null,
          shippingOfferCode: "demo:courier",
          paymentMethod: "cod",
          consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
          ...extra,
        };
        if (merged["expectedTotalMinor"] === undefined) {
          const preview = await checkout.preview({
            owner,
            destination: {
              countyCode: geo.countyCode,
              localityCode: (merged["shipping"] as { localityCode: number }).localityCode,
              postalCode: "123456",
            },
            offerCode: merged.shippingOfferCode as string,
            paymentMethod: merged.paymentMethod as "cod" | "bank_transfer" | "card",
            vatId: (merged["company"] as { vatId?: string } | null)?.vatId ?? null,
          });
          merged["expectedTotalMinor"] = preview.totals?.totalMinor ?? 1;
        }
        return merged;
      },
    };
    return fn(h);
  });
}

export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
  return "nicio eroare";
}

export const orderOf = (tx: TestTx, id: string) =>
  tx.order.findUniqueOrThrow({
    where: { id },
    include: {
      lines: true,
      addresses: true,
      // fără ORDER BY, Postgres nu garantează ordinea: un rând rescris (UPDATE) apare fizic după cele inserate ulterior
      payments: { orderBy: { attemptNo: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      stockCommitments: true,
      stockReservations: true,
    },
  });
