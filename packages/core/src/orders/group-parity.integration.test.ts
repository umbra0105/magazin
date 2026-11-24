import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { CartOwner, CartRuntimeSettings } from "../cart/cart-service";
import type { ShippingRuntimeSettings } from "../shipping/shipping-service";
import { NOW, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { createUser } from "../test-utils/digital-fixtures";
import type { CheckoutSettings } from "./checkout-service";

/**
 * TESTUL DE PARITATE al Fazei 15 (docs/20, CLAUDE.md «Prețuri»; S1 la orice diferență): coșuri FĂRĂ grup de clienți, plasate pe
 * Postgres real, cu toate valorile numerice ale previzualizării și ale comenzii (subtotal, reduceri, transport, taxă de
 * ramburs, TVA, total, linii, plăți, rezervări și angajări de stoc) comparate cu un fișier-fixture înregistrat pe `main`
 * NESCHIMBAT, ÎNAINTE de orice modificare în motor, coș sau checkout. Fixture-ul nu conține date calendaristice, ceasuri sau
 * identificatori: doar numere, coduri și durate (față de ceasul injectat `NOW`).
 *
 * Variante de cumpărător (aceleași coșuri, ACELEAȘI rezultate):
 *   - `guest`: oaspete;
 *   - `user`: client cu cont, fără grup;
 *   - `standard`: client cu cont în grupul «Client standard» (se adaugă după schema grupurilor; rezultatul trebuie să fie
 *     IDENTIC cu cel al variantei `user`).
 *
 * Înregistrare (doar pe cod neschimbat, de mână): `PARITY_RECORD=1`.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const FIXTURE_URL = new URL("./group-parity.fixture.json", import.meta.url);
const RECORD = process.env["PARITY_RECORD"] === "1";
const DEMO_CARD = { code: "demo", mode: "demo" } as const;
const COMPANY = { name: "FIRMA TEST SRL", vatId: "RO14399840" } as const;
const THRESHOLD = 50_000;
const DAY_MS = 86_400_000;

type ProductOpts = NonNullable<Parameters<Harness["product"]>[0]>;
type OfferWish = "cheapest" | "pickup" | "pallet" | "courier";
type Variant = "guest" | "user";
const VARIANTS: readonly Variant[] = ["guest", "user"];

interface ScenarioProduct {
  opts?: ProductOpts;
  quantity?: string;
  /** Preț promoțional; fereastra se calculează din ceasul injectat (`window`: activă implicit). */
  salePriceMinor?: number;
  window?: "active" | "expired" | "future";
}

interface Scenario {
  name: string;
  products: ScenarioProduct[];
  offer?: OfferWish;
  payment?: "cod" | "bank_transfer" | "card";
  company?: boolean;
  settings?: Partial<CheckoutSettings>;
  shipping?: Partial<ShippingRuntimeSettings>;
  cart?: Partial<CartRuntimeSettings>;
}

const SCENARIOS: Scenario[] = [
  { name: "01 ramburs, curier, un produs", products: [{ opts: { price: 19_900 } }] },
  {
    name: "02 ramburs, curier, două produse cu cantități",
    products: [{ opts: { price: 19_900 } }, { opts: { price: 5_050 }, quantity: "3" }],
  },
  {
    name: "03 ramburs, curier, rotunjirea TVA pe linie (12345 × 7)",
    products: [{ opts: { price: 12_345 }, quantity: "7" }],
  },
  {
    name: "04 card, curier",
    products: [{ opts: { price: 19_900 } }],
    payment: "card",
    settings: { cardProvider: DEMO_CARD },
  },
  {
    name: "05 card, ridicare personală",
    products: [{ opts: { price: 19_900 } }],
    payment: "card",
    offer: "pickup",
    settings: { cardProvider: DEMO_CARD },
  },
  {
    name: "06 transfer bancar, curier (rezervare de 3 zile lucrătoare)",
    products: [{ opts: { price: 19_900 } }, { opts: { price: 7_777 }, quantity: "2" }],
    payment: "bank_transfer",
  },
  {
    name: "07 transfer bancar, ridicare personală",
    products: [{ opts: { price: 19_900 } }],
    payment: "bank_transfer",
    offer: "pickup",
  },
  {
    name: "08 ramburs, ridicare personală (fără taxă de ramburs)",
    products: [{ opts: { price: 19_900 } }],
    offer: "pickup",
  },
  {
    name: "09 ramburs, produs supradimensionat",
    products: [{ opts: { price: 89_900, shippingClass: "oversized", weightGrams: 45_000 } }],
  },
  {
    name: "10 ramburs, un produs pe palet",
    products: [{ opts: { price: 129_900, shippingClass: "pallet", weightGrams: 120_000 } }],
    offer: "pallet",
  },
  {
    name: "11 ramburs, palet împreună cu un produs standard",
    products: [
      { opts: { price: 129_900, shippingClass: "pallet", weightGrams: 120_000 } },
      { opts: { price: 4_900 }, quantity: "2" },
    ],
    offer: "pallet",
  },
  {
    name: "12 ramburs, curier, greutate mare (tarif pe kilogram în plus)",
    products: [{ opts: { price: 9_900, weightGrams: 18_000 }, quantity: "2" }],
  },
  {
    name: "13 prag de transport gratuit: cu 1 ban sub prag",
    products: [{ opts: { price: THRESHOLD - 1 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "14 prag de transport gratuit: exact la prag",
    products: [{ opts: { price: THRESHOLD } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "15 prag de transport gratuit: cu 1 ban peste prag",
    products: [{ opts: { price: THRESHOLD + 1 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "16 prag de transport gratuit atins, cu taxă de ramburs",
    products: [{ opts: { price: 30_000 } }, { opts: { price: 20_000 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "17 prag atins, dar clasa supradimensionată nu e scutită",
    products: [{ opts: { price: 89_900, shippingClass: "oversized", weightGrams: 45_000 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "18 cantitate zecimală, pas de 0,3 (6,3 × 123,45)",
    products: [{ opts: { price: 12_345, step: "0,3" }, quantity: "6,3" }],
  },
  {
    name: "19 cantitate zecimală, pas de 0,05 (3,65 × 99,99)",
    products: [{ opts: { price: 9_999, step: "0,05" }, quantity: "3,65" }],
  },
  {
    name: "20 produs «La comandă» cu transfer bancar",
    products: [{ opts: { price: 25_000, physical: "0", allowBackorder: true } }],
    payment: "bank_transfer",
  },
  {
    name: "21 produs «La comandă» cu ramburs (refuzat)",
    products: [{ opts: { price: 25_000, physical: "0", allowBackorder: true } }],
    payment: "cod",
  },
  {
    name: "22 stoc limitat, ramburs",
    products: [{ opts: { price: 15_000, physical: "2" } }],
  },
  {
    name: "23 stoc negestionat, ramburs",
    products: [{ opts: { price: 15_000, manageStock: false, stockStatus: "instock" } }],
  },
  {
    name: "24 peste limita de ramburs pentru persoane fizice (refuzat)",
    products: [{ opts: { price: 1_100_000 } }],
  },
  {
    name: "25 persoană juridică, sub limita de ramburs pentru firme",
    products: [{ opts: { price: 450_000 } }],
    company: true,
  },
  {
    name: "26 persoană juridică, peste limita de ramburs pentru firme (refuzat)",
    products: [{ opts: { price: 520_000 } }],
    company: true,
  },
  {
    name: "27 promoție activă, afișată",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950 }],
    cart: { showSalePricing: true },
  },
  {
    name: "28 promoție activă, dar afișarea ei e oprită",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950 }],
    cart: { showSalePricing: false },
  },
  {
    name: "29 indicatorul pragului de transport din coș",
    products: [{ opts: { price: 80_000 } }],
    cart: { freeShippingThreshold: 100_000 },
  },
  {
    name: "30 promoție expirată (fereastra s-a încheiat ieri), afișarea pornită",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950, window: "expired" }],
    cart: { showSalePricing: true },
  },
  {
    name: "31 promoție viitoare (începe mâine), afișarea pornită",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950, window: "future" }],
    cart: { showSalePricing: true },
  },
  {
    name: "32 trei linii: promoție, cantitate zecimală și produs obișnuit, card",
    products: [
      { opts: { price: 33_333 }, salePriceMinor: 29_999, quantity: "3" },
      { opts: { price: 12_345, step: "0,3" }, quantity: "2,4" },
      { opts: { price: 4_999 } },
    ],
    payment: "card",
    settings: { cardProvider: DEMO_CARD },
    cart: { showSalePricing: true },
  },
  {
    name: "33 promoție care coboară sub pragul de transport gratuit, ramburs",
    products: [{ opts: { price: 60_000 }, salePriceMinor: 45_000 }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
    cart: { showSalePricing: true },
  },
  {
    name: "34 cinci linii cu fracțiuni de ban pe linie, transfer bancar",
    products: [
      { opts: { price: 3_333 }, quantity: "3" },
      { opts: { price: 1_111 }, quantity: "7" },
      { opts: { price: 9_999 }, quantity: "2" },
      { opts: { price: 2_501 }, quantity: "5" },
      { opts: { price: 77_777 } },
    ],
    payment: "bank_transfer",
  },
  {
    name: "35 palet cu promoție, transfer bancar",
    products: [
      {
        opts: { price: 129_900, shippingClass: "pallet", weightGrams: 120_000 },
        salePriceMinor: 99_900,
      },
    ],
    offer: "pallet",
    payment: "bank_transfer",
    cart: { showSalePricing: true },
  },
];

const jsonSafe = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );

const offsetMs = (date: Date | null): number | null =>
  date ? date.getTime() - NOW.getTime() : null;

function saleWindow(window: ScenarioProduct["window"]): { start: Date; end: Date } {
  if (window === "expired") {
    return { start: new Date(NOW.getTime() - 3 * DAY_MS), end: new Date(NOW.getTime() - DAY_MS) };
  }
  if (window === "future") {
    return { start: new Date(NOW.getTime() + DAY_MS), end: new Date(NOW.getTime() + 3 * DAY_MS) };
  }
  return { start: new Date(NOW.getTime() - DAY_MS), end: new Date(NOW.getTime() + DAY_MS) };
}

/** Creează cumpărătorul variantei și îi umple coșul; întoarce proprietarul coșului. */
async function fillFor(
  h: Harness,
  variant: Variant,
  items: Array<{ variantId: string; quantity?: string }>,
): Promise<{ owner: CartOwner; userId: string | null }> {
  if (variant === "guest") {
    const owner = await h.fill(
      items.map((item) => ({
        variantId: item.variantId,
        ...(item.quantity ? { quantity: q(item.quantity) } : {}),
      })),
    );
    return { owner, userId: null };
  }
  const user = await createUser(h.tx, true);
  const owner: CartOwner = { kind: "user", userId: user.id };
  for (const item of items) {
    await h.cart.add(owner, {
      variantId: item.variantId,
      quantity: item.quantity ? q(item.quantity) : "minimum",
    });
  }
  return { owner, userId: user.id };
}

async function runScenario(scenario: Scenario, variant: Variant): Promise<unknown> {
  return harness(
    async (h) => {
      const variants: string[] = [];
      for (const entry of scenario.products) {
        const product = await h.product(entry.opts ?? {});
        variants.push(product.variantId);
        if (entry.salePriceMinor !== undefined) {
          const { start, end } = saleWindow(entry.window);
          await h.tx.productVariant.update({
            where: { id: product.variantId },
            data: { salePrice: entry.salePriceMinor, saleStartsAt: start, saleEndsAt: end },
          });
        }
      }
      const { owner } = await fillFor(
        h,
        variant,
        scenario.products.map((entry, index) => ({
          variantId: variants[index] as string,
          ...(entry.quantity ? { quantity: entry.quantity } : {}),
        })),
      );
      const destination = {
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        postalCode: "123456",
      };
      const payment = scenario.payment ?? "cod";
      const vatId = scenario.company ? COMPANY.vatId : null;

      const first = await h.checkout.preview({ owner, destination, paymentMethod: payment, vatId });
      const offers = first.shipping?.offers ?? [];
      const wish = scenario.offer ?? "cheapest";
      const chosen =
        wish === "cheapest"
          ? offers.find((offer) => offer.kind !== "pickup")
          : offers.find((offer) => offer.kind === wish);
      const offerCode = chosen?.code ?? "lipsă";

      const preview = await h.checkout.preview({
        owner,
        destination,
        offerCode,
        paymentMethod: payment,
        vatId,
      });
      const previewRecord = {
        blocked: preview.blocked?.code ?? null,
        taxRateBps: preview.taxRateBps,
        cart: {
          totals: preview.view.totals,
          canCheckout: preview.view.canCheckout,
          leadTime: preview.view.leadTime ? { days: preview.view.leadTime.days } : null,
          freeShipping: preview.view.freeShipping,
          lines: preview.view.lines.map((line) => ({
            quantityTicks: line.quantityTicks,
            state: line.state,
            leadTimeDays: line.leadTimeDays,
            remainingSteps: line.remainingSteps,
            issues: line.issues,
            included: line.included,
            pricing: line.pricing
              ? {
                  unitPriceMinor: line.pricing.unitPriceMinor,
                  totalMinor: line.pricing.totalMinor,
                  netMinor: line.pricing.netMinor,
                  vatMinor: line.pricing.vatMinor,
                  taxRateBps: line.pricing.taxRateBps,
                }
              : null,
          })),
        },
        shipping: preview.shipping
          ? {
              offers: preview.shipping.offers.map((offer) => ({
                code: offer.code,
                kind: offer.kind,
                priceMinor: offer.priceMinor,
                codFeeMinor: offer.codFeeMinor,
                estimatedDays: offer.estimatedDays,
                freeShipping: offer.freeShipping,
                source: offer.source,
              })),
              fallbackUsed: preview.shipping.fallbackUsed,
              providerProblem: preview.shipping.providerProblem,
              freeShipping: preview.shipping.freeShipping,
              incomplete: preview.shipping.incomplete,
              transport: preview.shipping.transport,
            }
          : null,
        selectedOffer: preview.selectedOffer?.code ?? null,
        methods: preview.methods,
        totals: preview.totals,
      };

      const input = await h.input(owner, {
        shippingOfferCode: offerCode,
        paymentMethod: payment,
        ...(scenario.company ? { company: COMPANY } : {}),
      });
      let placed: unknown;
      try {
        const result = await h.checkout.place(owner, input);
        const order = await orderOf(h.tx, result.orderId);
        const stock = await h.tx.inventoryItem.findMany({
          where: { variantId: { in: variants }, warehouseId: h.ctx.warehouseId },
          select: { variantId: true, physical: true, committed: true, reserved: true },
        });
        const stockOf = (variantId: string) => stock.find((item) => item.variantId === variantId);
        placed = {
          kind: "placed",
          replayed: result.replayed,
          hasPaymentId: result.paymentId !== null,
          order: {
            status: order.status,
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            subtotalMinor: order.subtotalMinor,
            discountMinor: order.discountMinor,
            shippingMinor: order.shippingMinor,
            codFeeMinor: order.codFeeMinor,
            shippingTaxMinor: order.shippingTaxMinor,
            codFeeTaxMinor: order.codFeeTaxMinor,
            taxMinor: order.taxMinor,
            totalMinor: order.totalMinor,
            taxRateBps: order.taxRateBps,
            groupPricingType: order.groupPricingType,
            currency: order.currency,
            shippingMethodCode: order.shippingMethodCode,
            shippingSnapshot: order.shippingSnapshot,
            paymentMethod: order.paymentMethod,
            installationRequested: order.installationRequested,
            hasCustomer: order.customerId !== null,
            digitalConsentAt: order.digitalConsentAt,
            digitalConsentText: order.digitalConsentText,
            digitalConsentVersion: order.digitalConsentVersion,
            reservationOffsetMs: offsetMs(order.reservationExpiresAt),
            retryDeadlineOffsetMs: offsetMs(order.paymentRetryDeadlineAt),
            confirmedOffsetMs: offsetMs(order.confirmedAt),
          },
          lines: order.lines
            .slice()
            // ordine DETERMINISTĂ după conținut: preț unitar descrescător, apoi cantitate, apoi total
            .sort(
              (a, b) =>
                b.unitPriceMinor - a.unitPriceMinor ||
                Number(BigInt(a.quantity) - BigInt(b.quantity)) ||
                b.lineTotalMinor - a.lineTotalMinor,
            )
            .map((line) => ({
              quantity: line.quantity,
              unitSymbol: line.unitSymbol,
              unitDecimals: line.unitDecimals,
              unitPriceMinor: line.unitPriceMinor,
              discountMinor: line.discountMinor,
              lineTotalMinor: line.lineTotalMinor,
              netMinor: line.netMinor,
              taxMinor: line.taxMinor,
              taxRateBps: line.taxRateBps,
              stockState: line.stockState,
              leadTimeDays: line.leadTimeDays,
              shippingClass: line.shippingClass,
              isDigital: line.isDigital,
            })),
          addressKinds: order.addresses.map((address) => address.kind).sort(),
          payments: order.payments.map((payment) => ({
            provider: payment.provider,
            method: payment.method,
            status: payment.status,
            amountMinor: payment.amountMinor,
            attemptNo: payment.attemptNo,
            mode: payment.mode,
          })),
          events: order.events.map((event) => event.type),
          commitments: order.stockCommitments
            .map((commitment) => ({ quantity: commitment.quantity, status: commitment.status }))
            .sort((a, b) => String(a.quantity).localeCompare(String(b.quantity))),
          reservations: order.stockReservations
            .map((reservation) => ({
              quantity: reservation.quantity,
              status: reservation.status,
              expiresOffsetMs: offsetMs(reservation.expiresAt),
            }))
            .sort((a, b) => String(a.quantity).localeCompare(String(b.quantity))),
          inventory: variants.map((variantId) => {
            const item = stockOf(variantId);
            return item
              ? { physical: item.physical, committed: item.committed, reserved: item.reserved }
              : null;
          }),
          cartAfter: (await h.cart.view(owner)).lines.length,
        };
      } catch (error) {
        placed = { kind: "refused", code: (error as { code?: string }).code ?? "fără cod" };
      }
      return jsonSafe({ preview: previewRecord, placed });
    },
    {
      ...(scenario.settings ? { settings: scenario.settings } : {}),
      ...(scenario.shipping ? { shipping: scenario.shipping } : {}),
      ...(scenario.cart ? { cart: scenario.cart } : {}),
    },
  );
}

type Fixture = Record<string, Record<string, unknown>>;
const recorded: Fixture = {};

afterAll(() => {
  if (!RECORD) return;
  const sorted = Object.fromEntries(
    Object.entries(recorded)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([variant, entries]) => [
        variant,
        Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
  writeFileSync(fileURLToPath(FIXTURE_URL), `${JSON.stringify(sorted, null, 2)}\n`);
});

const readFixture = (): Fixture =>
  JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8")) as Fixture;

describe("paritatea cu `main` pentru coșuri fără grup (Faza 15)", () => {
  it("are cel puțin 30 de coșuri, cu nume unice", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(SCENARIOS.length);
  });

  for (const variant of VARIANTS) {
    for (const scenario of SCENARIOS) {
      it(`[${variant}] ${scenario.name}`, async () => {
        const actual = await runScenario(scenario, variant);
        if (RECORD) {
          (recorded[variant] ??= {})[scenario.name] = actual;
          return;
        }
        const fixture = readFixture();
        expect(fixture[variant]?.[scenario.name], "scenariul lipsește din fixture").toBeDefined();
        expect(actual).toEqual(fixture[variant]?.[scenario.name]);
      });
    }
  }

  it("fixture-ul are exact variantele și scenariile din test", () => {
    if (RECORD) return;
    const fixture = readFixture();
    expect(Object.keys(fixture).sort()).toEqual([...VARIANTS].sort());
    for (const variant of VARIANTS) {
      expect(Object.keys(fixture[variant] ?? {}).sort()).toEqual(
        SCENARIOS.map((scenario) => scenario.name).sort(),
      );
    }
  });

  it("fixture-ul nu e gol: comenzi plasate și refuzate, cu și fără promoție", () => {
    if (RECORD) return;
    const fixture = readFixture();
    for (const variant of VARIANTS) {
      const entries = Object.values(fixture[variant] ?? {}) as Array<{ placed: { kind: string } }>;
      expect(
        entries.filter((entry) => entry.placed.kind === "placed").length,
      ).toBeGreaterThanOrEqual(24);
      expect(entries.some((entry) => entry.placed.kind === "refused")).toBe(true);
    }
  });
});
