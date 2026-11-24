import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { CartRuntimeSettings } from "../cart/cart-service";
import type { ShippingRuntimeSettings } from "../shipping/shipping-service";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import type { CheckoutSettings } from "./checkout-service";

/**
 * TESTUL DE PARITATE al Fazei 14c (docs/20, CLAUDE.md «Prețuri»): coșuri FĂRĂ produse digitale, plasate pe Postgres real, cu
 * toate valorile numerice ale previzualizării și ale comenzii (subtotal, reduceri, transport, taxă de ramburs, TVA, total,
 * linii, plăți, rezervări și angajări de stoc) comparate cu un fișier-fixture înregistrat pe `main` ÎNAINTE de orice
 * modificare în checkout. Orice diferență, de orice mărime, la un coș fără produse digitale înseamnă că faza a atins bani sau
 * stoc: oprire (S1). Fixture-ul NU conține date calendaristice, ceasuri sau identificatori: doar numere, coduri și durate
 * (rezervările se compară ca decalaj față de ceasul injectat `NOW`).
 *
 * Înregistrare (doar pe cod neschimbat, de mână): `PARITY_RECORD=1`. Grupurile de clienți și cupoanele nu există încă în
 * coș (`GROUP_NONE` și `coupon: null` în `CartService`, Faza 15), deci nu pot apărea într-un coș de checkout; promoția activă,
 * prețul pe pas zecimal, clasele de transport și pragul de transport gratuit sunt acoperite mai jos.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const FIXTURE_URL = new URL("./checkout-parity.fixture.json", import.meta.url);
const RECORD = process.env["PARITY_RECORD"] === "1";
const DEMO_CARD = { code: "demo", mode: "demo" } as const;
const COMPANY = { name: "FIRMA TEST SRL", vatId: "RO14399840" } as const;
const THRESHOLD = 50_000;

type ProductOpts = NonNullable<Parameters<Harness["product"]>[0]>;
type OfferWish = "cheapest" | "pickup" | "pallet" | "courier";

interface ScenarioProduct {
  opts?: ProductOpts;
  quantity?: string;
  /** Preț promoțional activ (fereastra se calculează din ceasul injectat). */
  salePriceMinor?: number;
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

const DAY_MS = 86_400_000;

const SCENARIOS: Scenario[] = [
  { name: "ramburs, curier, un produs", products: [{ opts: { price: 19_900 } }] },
  {
    name: "ramburs, curier, două produse cu cantități",
    products: [{ opts: { price: 19_900 } }, { opts: { price: 5_050 }, quantity: "3" }],
  },
  {
    name: "ramburs, curier, rotunjirea TVA pe linie (12345 × 7)",
    products: [{ opts: { price: 12_345 }, quantity: "7" }],
  },
  {
    name: "card, curier",
    products: [{ opts: { price: 19_900 } }],
    payment: "card",
    settings: { cardProvider: DEMO_CARD },
  },
  {
    name: "card, ridicare personală",
    products: [{ opts: { price: 19_900 } }],
    payment: "card",
    offer: "pickup",
    settings: { cardProvider: DEMO_CARD },
  },
  {
    name: "transfer bancar, curier (rezervare de 3 zile lucrătoare)",
    products: [{ opts: { price: 19_900 } }, { opts: { price: 7_777 }, quantity: "2" }],
    payment: "bank_transfer",
  },
  {
    name: "transfer bancar, ridicare personală",
    products: [{ opts: { price: 19_900 } }],
    payment: "bank_transfer",
    offer: "pickup",
  },
  {
    name: "ramburs, ridicare personală (fără taxă de ramburs)",
    products: [{ opts: { price: 19_900 } }],
    offer: "pickup",
  },
  {
    name: "ramburs, produs supradimensionat",
    products: [{ opts: { price: 89_900, shippingClass: "oversized", weightGrams: 45_000 } }],
  },
  {
    name: "ramburs, un produs pe palet",
    products: [{ opts: { price: 129_900, shippingClass: "pallet", weightGrams: 120_000 } }],
    offer: "pallet",
  },
  {
    name: "ramburs, palet împreună cu un produs standard",
    products: [
      { opts: { price: 129_900, shippingClass: "pallet", weightGrams: 120_000 } },
      { opts: { price: 4_900 }, quantity: "2" },
    ],
    offer: "pallet",
  },
  {
    name: "ramburs, curier, greutate mare (tarif pe kilogram în plus)",
    products: [{ opts: { price: 9_900, weightGrams: 18_000 }, quantity: "2" }],
  },
  {
    name: "prag de transport gratuit: cu 1 ban sub prag",
    products: [{ opts: { price: THRESHOLD - 1 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "prag de transport gratuit: exact la prag",
    products: [{ opts: { price: THRESHOLD } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "prag de transport gratuit: cu 1 ban peste prag",
    products: [{ opts: { price: THRESHOLD + 1 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "prag de transport gratuit atins, cu taxă de ramburs",
    products: [{ opts: { price: 30_000 } }, { opts: { price: 20_000 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "prag atins, dar clasa supradimensionată nu e scutită",
    products: [{ opts: { price: 89_900, shippingClass: "oversized", weightGrams: 45_000 } }],
    shipping: { freeShippingThresholdMinor: THRESHOLD },
  },
  {
    name: "cantitate zecimală, pas de 0,3 (6,3 × 123,45)",
    products: [{ opts: { price: 12_345, step: "0,3" }, quantity: "6,3" }],
  },
  {
    name: "cantitate zecimală, pas de 0,05 (3,65 × 99,99)",
    products: [{ opts: { price: 9_999, step: "0,05" }, quantity: "3,65" }],
  },
  {
    name: "produs «La comandă» cu transfer bancar",
    products: [{ opts: { price: 25_000, physical: "0", allowBackorder: true } }],
    payment: "bank_transfer",
  },
  {
    name: "produs «La comandă» cu ramburs (refuzat)",
    products: [{ opts: { price: 25_000, physical: "0", allowBackorder: true } }],
    payment: "cod",
  },
  {
    name: "stoc limitat, ramburs",
    products: [{ opts: { price: 15_000, physical: "2" } }],
  },
  {
    name: "stoc negestionat, ramburs",
    products: [{ opts: { price: 15_000, manageStock: false, stockStatus: "instock" } }],
  },
  {
    name: "peste limita de ramburs pentru persoane fizice (refuzat)",
    products: [{ opts: { price: 1_100_000 } }],
  },
  {
    name: "persoană juridică, sub limita de ramburs pentru firme",
    products: [{ opts: { price: 450_000 } }],
    company: true,
  },
  {
    name: "persoană juridică, peste limita de ramburs pentru firme (refuzat)",
    products: [{ opts: { price: 520_000 } }],
    company: true,
  },
  {
    name: "promoție activă, afișată",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950 }],
    cart: { showSalePricing: true },
  },
  {
    name: "promoție activă, dar afișarea ei e oprită",
    products: [{ opts: { price: 19_900 }, salePriceMinor: 9_950 }],
    cart: { showSalePricing: false },
  },
  {
    name: "indicatorul pragului de transport din coș",
    products: [{ opts: { price: 80_000 } }],
    cart: { freeShippingThreshold: 100_000 },
  },
];

const jsonSafe = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );

const offsetMs = (date: Date | null): number | null =>
  date ? date.getTime() - NOW.getTime() : null;

async function runScenario(scenario: Scenario): Promise<unknown> {
  return harness(
    async (h) => {
      const variants: string[] = [];
      for (const entry of scenario.products) {
        const product = await h.product(entry.opts ?? {});
        variants.push(product.variantId);
        if (entry.salePriceMinor !== undefined) {
          await h.tx.productVariant.update({
            where: { id: product.variantId },
            data: {
              salePrice: entry.salePriceMinor,
              saleStartsAt: new Date(NOW.getTime() - DAY_MS),
              saleEndsAt: new Date(NOW.getTime() + DAY_MS),
            },
          });
        }
      }
      const owner = await h.fill(
        scenario.products.map((entry, index) => ({
          variantId: variants[index] as string,
          ...(entry.quantity ? { quantity: q(entry.quantity) } : {}),
        })),
      );
      const destination = {
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        postalCode: "123456",
      };
      const payment = scenario.payment ?? "cod";
      const vatId = scenario.company ? COMPANY.vatId : null;

      // oferta dorită, aleasă din cele returnate (ordinea și prețurile sunt ele însele parte din comparație)
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

      // plasarea: comanda, liniile, plata, evenimentele, rezervările și angajările
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
            customerId: order.customerId,
            digitalConsentAt: order.digitalConsentAt,
            digitalConsentText: order.digitalConsentText,
            digitalConsentVersion: order.digitalConsentVersion,
            reservationOffsetMs: offsetMs(order.reservationExpiresAt),
            retryDeadlineOffsetMs: offsetMs(order.paymentRetryDeadlineAt),
            confirmedOffsetMs: offsetMs(order.confirmedAt),
          },
          lines: order.lines
            .slice()
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.unitPriceMinor - b.unitPriceMinor,
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

const recorded: Record<string, unknown> = {};

afterAll(() => {
  if (!RECORD) return;
  const sorted = Object.fromEntries(
    Object.entries(recorded).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(fileURLToPath(FIXTURE_URL), `${JSON.stringify(sorted, null, 2)}\n`);
});

describe("paritatea checkout-ului pentru coșuri fără produse digitale (Faza 14c)", () => {
  it("are cel puțin 20 de coșuri, cu nume unice", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(SCENARIOS.length);
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const actual = await runScenario(scenario);
      if (RECORD) {
        recorded[scenario.name] = actual;
        return;
      }
      const fixture = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8")) as Record<
        string,
        unknown
      >;
      expect(fixture[scenario.name], "scenariul lipsește din fixture").toBeDefined();
      expect(actual).toEqual(fixture[scenario.name]);
    });
  }

  it("fixture-ul are exact scenariile din test (niciunul în plus, niciunul lipsă)", () => {
    if (RECORD) return;
    const fixture = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(fixture).sort()).toEqual(SCENARIOS.map((scenario) => scenario.name).sort());
  });

  it("cel puțin o comandă din fiecare tip chiar s-a plasat și una a fost refuzată (fixture-ul nu e gol)", async () => {
    if (RECORD) return;
    const fixture = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8")) as Record<
      string,
      { placed: { kind: string } }
    >;
    const kinds = Object.values(fixture).map((entry) => entry.placed.kind);
    expect(kinds.filter((kind) => kind === "placed").length).toBeGreaterThanOrEqual(20);
    expect(kinds).toContain("refused");
    expect(await codeOf(Promise.resolve())).toBe("nicio eroare");
  });
});
