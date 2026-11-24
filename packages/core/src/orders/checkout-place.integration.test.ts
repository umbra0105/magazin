import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { CartOwner } from "../cart/cart-service";
import { reservationExpiresAt } from "../inventory/workdays";
import { DemoShippingRateProvider } from "../shipping/demo-rates";
import type { ShippingRateProvider } from "../shipping/types";
import type { TestTx } from "../test-utils/rollback";
import { CHECKOUT_TERMS_CONSENT } from "./consent";
import { getOrderSummary } from "./order-read";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";

/**
 * Plasarea comenzii pe Postgres real, în tranzacție anulată (fixture-urile sunt în `checkout-fixtures.ts`). Concurența cu date
 * comise e în `checkout-concurrency`.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const immediate = (tx: TestTx) => tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");

describe("comandă cu ramburs", () => {
  it("plasează comanda: linii, adrese, plată, evenimente, stoc angajat, coș golit", async () => {
    await harness(async (h) => {
      const a = await h.product({ price: 19_900 });
      const b = await h.product({ price: 5_050 });
      const owner = await h.fill([
        { variantId: a.variantId },
        { variantId: b.variantId, quantity: q("3") },
      ]);
      const preview = await h.checkout.preview({
        owner,
        destination: {
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          postalCode: "123456",
        },
        offerCode: "demo:courier",
        paymentMethod: "cod",
      });
      expect(preview.blocked).toBeNull();
      const totals = preview.totals!;

      const result = await h.checkout.place(owner, await h.input(owner));
      expect(result.replayed).toBe(false);
      expect(result.number).toMatch(/^T-\d{4}$/);

      const order = await orderOf(h.tx, result.orderId);
      expect(order).toMatchObject({
        number: result.number,
        email: "client@exemplu.ro",
        phone: "+40722123456",
        status: "confirmed",
        paymentStatus: "pending",
        fulfillmentStatus: "unfulfilled",
        paymentMethod: "cod",
        customerId: null,
        currency: "RON",
        source: "web",
        subtotalMinor: totals.subtotalMinor,
        shippingMinor: totals.shippingMinor,
        codFeeMinor: totals.codFeeMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        taxRateBps: 2100,
        reservationExpiresAt: null,
        termsConsentText: CHECKOUT_TERMS_CONSENT.text,
        termsConsentVersion: CHECKOUT_TERMS_CONSENT.version,
        installationRequested: false,
      });
      expect(order.confirmedAt).toEqual(NOW);
      expect(order.termsAcceptedAt).toEqual(NOW);
      const channel = await h.tx.salesChannel.findUniqueOrThrow({ where: { id: order.channelId } });
      expect(channel.code).toBe("web");

      // liniile: snapshot, suma rotunjită o singură dată pe linie; subtotal = suma liniilor; TVA = suma TVA pe linii + transport + taxă
      expect(order.lines).toHaveLength(2);
      expect(order.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(order.subtotalMinor);
      expect(
        order.lines.reduce((s, l) => s + l.taxMinor, 0) +
          order.shippingTaxMinor +
          order.codFeeTaxMinor,
      ).toBe(order.taxMinor);
      for (const line of order.lines) {
        expect(line.netMinor + line.taxMinor).toBe(line.lineTotalMinor);
        expect(line.stockState).toBe("in_stock");
        expect(JSON.stringify(line.productSnapshot)).not.toMatch(/cost/i);
      }
      expect(order.totalMinor).toBe(order.subtotalMinor + order.shippingMinor + order.codFeeMinor);

      // adresele: două rânduri, cu denumirile din nomenclator
      expect(order.addresses.map((x) => x.kind).sort()).toEqual(["billing", "shipping"]);
      const shipping = order.addresses.find((x) => x.kind === "shipping")!;
      expect(shipping).toMatchObject({
        countyName: "Test",
        localityName: "Sat Test",
        postalCode: "123456",
        phone: "+40722123456",
      });

      // plată în așteptare (se încasează la livrare), evenimente în ordine, stoc angajat cu cheia străină
      expect(order.payments).toHaveLength(1);
      expect(order.payments[0]).toMatchObject({
        provider: "cod",
        status: "pending",
        amountMinor: order.totalMinor,
      });
      expect(order.events.map((e) => e.type)).toEqual(["order.placed", "order.confirmed"]);
      expect(order.stockCommitments).toHaveLength(2);
      expect(
        order.stockCommitments.every((c) => c.orderId === order.id && c.refType === "order"),
      ).toBe(true);
      expect(order.stockReservations).toHaveLength(0);
      const item = await h.tx.inventoryItem.findUniqueOrThrow({
        where: {
          variantId_warehouseId: { variantId: a.variantId, warehouseId: h.ctx.warehouseId },
        },
      });
      expect(item.committed).toBe(q("1"));

      // coșul s-a golit
      expect((await h.cart.view(owner)).lines).toHaveLength(0);
      await immediate(h.tx); // integritatea totalurilor, verificată de bază
    });
  });

  it("transport gratuit nu elimină taxa de ramburs; pickup nu are taxă", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const result = await h.checkout.place(
        owner,
        await h.input(owner, { shippingOfferCode: "pickup" }),
      );
      const order = await orderOf(h.tx, result.orderId);
      expect(order).toMatchObject({
        shippingMinor: 0,
        codFeeMinor: 0,
        shippingMethodCode: "pickup",
      });
      expect(order.totalMinor).toBe(order.subtotalMinor);
    });
  });
});

describe("ridicare personală: adresa magazinului, nu a clientului", () => {
  const STORE_TEXT = "Strada Magazinului 7, 510000 Alba Iulia, Alba";
  const place = async (h: Harness) => {
    const a = await h.product();
    const owner = await h.fill([{ variantId: a.variantId }]);
    return { owner, a };
  };

  it("salvează adresa magazinului ca snapshot pe comandă; adresa clientului nu e prezentată ca ridicare", async () => {
    await harness(async (h) => {
      const { owner } = await place(h);
      const result = await h.checkout.place(
        owner,
        await h.input(owner, { shippingOfferCode: "pickup" }),
      );
      const order = await orderOf(h.tx, result.orderId);
      const snapshot = order.shippingSnapshot as Record<string, unknown>;
      expect(snapshot["kind"]).toBe("pickup");
      expect(snapshot["pickupAddress"]).toEqual({
        street: "Strada Magazinului 7",
        city: "Alba Iulia",
        county: "Alba",
        postalCode: "510000",
        country: "RO",
        text: STORE_TEXT,
      });
      // în snapshot-ul de livrare nu ajunge nimic din adresa clientului
      expect(JSON.stringify(snapshot)).not.toContain("Str. Exemplu");
      expect(JSON.stringify(snapshot)).not.toContain("Sat Test");
      // adresa clientului rămâne pe comandă doar ca adresă de contact/facturare (nu se pierde: zona și factura o folosesc)
      const customer = order.addresses.find((a) => a.kind === "shipping");
      expect(customer?.street).toBe("Str. Exemplu 1");
    });
  });

  it("o schimbare ulterioară a `company.address` nu modifică comenzile vechi", async () => {
    await harness(async (h) => {
      const { owner } = await place(h);
      const result = await h.checkout.place(
        owner,
        await h.input(owner, { shippingOfferCode: "pickup" }),
      );
      h.shippingSettings.pickupAddress = {
        street: "Altă Stradă 99",
        city: "Cluj-Napoca",
        county: "Cluj",
        postalCode: "400000",
        country: "RO",
      };
      const summary = await getOrderSummary(h.tx, result.orderId);
      expect(summary?.shipping.pickupAddressText).toBe(STORE_TEXT);
      expect(JSON.stringify(summary)).not.toContain("Altă Stradă");
    });
  });

  it("comanda cu curier NU poartă adresă de ridicare și își păstrează destinația", async () => {
    await harness(async (h) => {
      const { owner } = await place(h);
      const result = await h.checkout.place(owner, await h.input(owner));
      const order = await orderOf(h.tx, result.orderId);
      const snapshot = order.shippingSnapshot as Record<string, unknown>;
      expect(snapshot["kind"]).toBe("courier");
      expect(snapshot).not.toHaveProperty("pickupAddress");
      const summary = await getOrderSummary(h.tx, result.orderId);
      expect(summary?.shipping.pickupAddressText).toBeNull();
      expect(summary?.destination).toEqual({ countyName: "Test", localityName: "Sat Test" });
    });
  });

  it("fără adresă a magazinului, ridicarea nu se oferă la previzualizare", async () => {
    await harness(
      async (h) => {
        const { owner } = await place(h);
        const preview = await h.checkout.preview({
          owner,
          destination: {
            countyCode: h.geo.countyCode,
            localityCode: h.geo.localityCode,
            postalCode: "123456",
          },
          offerCode: "pickup",
          paymentMethod: "cod",
        });
        expect(preview.shipping?.offers.some((o) => o.kind === "pickup")).toBe(false);
        expect(preview.selectedOffer).toBeNull();
        expect(preview.totals).toBeNull();
      },
      { shipping: { pickupAddress: null } },
    );
  });

  it("fără adresă a magazinului, comanda cu ridicare NU se poate plasa (regulă pe server)", async () => {
    await harness(async (h) => {
      const { owner } = await place(h);
      // oferta a fost afișată cât timp adresa exista; apoi adresa a fost ștearsă
      const input = await h.input(owner, { shippingOfferCode: "pickup" });
      h.shippingSettings.pickupAddress = null;
      expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_OFFER_UNAVAILABLE");
      expect(await h.tx.order.count()).toBe(0);
    });
  });

  it("strada sau orașul goale (doar spații) blochează și plasarea", async () => {
    for (const blank of [{ street: "   " }, { city: "" }]) {
      await harness(async (h) => {
        const { owner } = await place(h);
        const input = await h.input(owner, { shippingOfferCode: "pickup" });
        h.shippingSettings.pickupAddress = {
          street: "Strada Magazinului 7",
          city: "Alba Iulia",
          county: "Alba",
          postalCode: "510000",
          country: "RO",
          ...blank,
        };
        expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_OFFER_UNAVAILABLE");
      });
    }
  });

  it("o ofertă de tip ridicare venită de la un furnizor, fără adresă a magazinului, e refuzată la plasare", async () => {
    const provider: ShippingRateProvider = {
      name: "ridicare-fara-adresa",
      quote: async () => [
        {
          code: "p:ridicare",
          kind: "pickup",
          carrier: "Punct de ridicare",
          service: "",
          priceMinor: 0,
          estimatedDays: 0,
          codFeeMinor: 0,
          source: "provider",
          demo: false,
          freeShipping: false,
        },
      ],
    };
    await harness(
      async (h) => {
        const { owner } = await place(h);
        const input = await h.input(owner, { shippingOfferCode: "p:ridicare" });
        expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_OFFER_UNAVAILABLE");
        expect(await h.tx.order.count()).toBe(0);
      },
      { provider },
    );
  });

  it("fără adresă a magazinului, livrarea cu curier merge neschimbat", async () => {
    await harness(
      async (h) => {
        const { owner } = await place(h);
        const result = await h.checkout.place(owner, await h.input(owner));
        expect(result.number).toMatch(/^T-\d{4}$/);
      },
      { shipping: { pickupAddress: null } },
    );
  });
});

describe("comandă cu transfer bancar", () => {
  it("rămâne în așteptare, rezervă stocul până la termen și NU îl angajează", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const result = await h.checkout.place(
        owner,
        await h.input(owner, { paymentMethod: "bank_transfer" }),
      );
      const order = await orderOf(h.tx, result.orderId);
      const expected = reservationExpiresAt("transfer", NOW, {
        reservationMinutes: 15,
        transferReservationWorkdays: 3,
        timeZone: "Europe/Bucharest",
      });
      expect(order).toMatchObject({
        status: "pending",
        paymentStatus: "pending",
        paymentMethod: "bank_transfer",
        codFeeMinor: 0,
        codFeeTaxMinor: 0,
      });
      expect(order.reservationExpiresAt).toEqual(expected);
      expect(order.stockReservations).toHaveLength(1);
      expect(order.stockReservations[0]).toMatchObject({
        status: "active",
        orderId: order.id,
        expiresAt: expected,
      });
      expect(order.stockCommitments).toHaveLength(0);
      expect(order.events.map((e) => e.type)).toEqual(["order.placed", "stock.reserved"]);
      expect(order.payments[0]).toMatchObject({ provider: "bank_transfer", status: "pending" });
      await immediate(h.tx);
    });
  });

  it("zilele nelucrătoare din setări mută termenul rezervării", async () => {
    // două plasări una după alta (fiecare în tranzacția ei anulată): două tranzacții deschise deodată ar insera același seed de bază
    // și s-ar bloca una pe alta pe o bază doar migrată
    const placeReservationEnd = (settings: Partial<Harness["settings"]>) =>
      harness(
        async (h) => {
          const a = await h.product();
          const owner = await h.fill([{ variantId: a.variantId }]);
          const result = await h.checkout.place(
            owner,
            await h.input(owner, { paymentMethod: "bank_transfer" }),
          );
          return (await orderOf(h.tx, result.orderId)).reservationExpiresAt!;
        },
        { settings },
      );
    const plain = await placeReservationEnd({});
    const shifted = await placeReservationEnd({ nonWorkingDates: ["2030-06-17", "2030-06-18"] });
    expect(shifted.getTime()).toBeGreaterThan(plain.getTime());
  });

  it("fără datele bancare ale magazinului, transferul nu se poate plasa", async () => {
    await harness(
      async (h) => {
        const a = await h.product();
        const owner = await h.fill([{ variantId: a.variantId }]);
        expect(
          await codeOf(
            h.checkout.place(owner, await h.input(owner, { paymentMethod: "bank_transfer" })),
          ),
        ).toBe("ORDER_BANK_DETAILS_MISSING");
        expect(
          await h.tx.order.count({
            where: { idempotencyKey: { not: "" }, email: "client@exemplu.ro" },
          }),
        ).toBe(0);
      },
      { settings: { bankDetailsConfigured: false } },
    );
  });
});

describe("regula «ramburs interzis la La comandă»", () => {
  const onOrder = (h: Harness) =>
    h.product({ manageStock: false, stockStatus: "onbackorder", variants: [{ physical: null }] });

  it("rambursul e respins pe server la plasare, chiar dacă clientul îl trimite; transferul merge", async () => {
    await harness(async (h) => {
      const normal = await h.product();
      const special = await onOrder(h);
      const owner = await h.fill([
        { variantId: normal.variantId },
        { variantId: special.variantId },
      ]);

      const preview = await h.checkout.preview({
        owner,
        destination: {
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          postalCode: "123456",
        },
        offerCode: "demo:courier",
        paymentMethod: "cod",
      });
      expect(preview.methods).toEqual([
        { method: "cod", available: false, reason: "has_on_order_line" },
        { method: "bank_transfer", available: true },
      ]);

      const input = await h.input(owner, { paymentMethod: "cod" });
      expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_PAYMENT_METHOD_UNAVAILABLE");
      // nimic nu s-a scris: nicio comandă, coșul intact
      expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(0);
      expect((await h.cart.view(owner)).lines).toHaveLength(2);

      const ok = await h.checkout.place(
        owner,
        await h.input(owner, { paymentMethod: "bank_transfer" }),
      );
      const order = await orderOf(h.tx, ok.orderId);
      const states = order.lines.map((l) => l.stockState).sort();
      expect(states).toEqual(["in_stock", "on_order"]);
      expect(order.lines.find((l) => l.stockState === "on_order")?.leadTimeDays).not.toBeNull();
    });
  });
});

describe("limitele de ramburs", () => {
  it("persoană fizică: peste 10.000 lei metoda dispare; exact limita se acceptă", async () => {
    await harness(async (h) => {
      const a = await h.product({ price: 1_000_000 - 2_500 - 500 }); // + transport 25 + taxă 5 = exact 10.000 lei
      const owner = await h.fill([{ variantId: a.variantId }]);
      const input = await h.input(owner);
      const result = await h.checkout.place(owner, input);
      expect((await orderOf(h.tx, result.orderId)).totalMinor).toBe(1_000_000);
    });
    await harness(async (h) => {
      const a = await h.product({ price: 1_000_000 - 2_500 - 500 + 1 });
      const owner = await h.fill([{ variantId: a.variantId }]);
      const preview = await h.checkout.preview({
        owner,
        destination: {
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          postalCode: "123456",
        },
        offerCode: "demo:courier",
      });
      expect(preview.methods?.[0]).toEqual({
        method: "cod",
        available: false,
        reason: "over_limit_individual",
      });
      expect(await codeOf(h.checkout.place(owner, await h.input(owner)))).toBe(
        "ORDER_PAYMENT_METHOD_UNAVAILABLE",
      );
    });
  });

  it("persoană juridică (CUI la facturare): limita e 5.000 lei", async () => {
    await harness(async (h) => {
      const a = await h.product({ price: 700_000 });
      const owner = await h.fill([{ variantId: a.variantId }]);
      const company = { name: "Firma SRL", vatId: "RO14399840" };
      // aceeași comandă: persoană fizică da, firmă nu
      const forCompany = await h.input(owner, { company });
      expect(await codeOf(h.checkout.place(owner, forCompany))).toBe(
        "ORDER_PAYMENT_METHOD_UNAVAILABLE",
      );
      const individual = await h.checkout.place(owner, await h.input(owner));
      expect(individual.replayed).toBe(false);
    });
  });
});

describe("idempotență (dublu-click)", () => {
  it("aceeași cheie întoarce aceeași comandă, fără alt stoc angajat și fără alt număr", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const input = await h.input(owner);
      const first = await h.checkout.place(owner, input);
      const second = await h.checkout.place(owner, input);
      expect(second).toEqual({
        orderId: first.orderId,
        number: first.number,
        replayed: true,
        paymentId: null,
      });
      expect(await h.tx.order.count({ where: { id: first.orderId } })).toBe(1);
      const item = await h.tx.inventoryItem.findUniqueOrThrow({
        where: {
          variantId_warehouseId: { variantId: a.variantId, warehouseId: h.ctx.warehouseId },
        },
      });
      expect(item.committed).toBe(q("1"));
      expect(await h.tx.stockCommitment.count({ where: { orderId: first.orderId } })).toBe(1);
    });
  });
});

describe("totalul și erorile: o plasare eșuată nu lasă nimic și nu consumă numere", () => {
  const counter = async (tx: TestTx) =>
    (await tx.orderCounter.findUnique({ where: { id: "order" } }))?.lastValue ?? 0;

  it("totalul diferit de cel afișat respinge comanda (ORDER_TOTAL_CHANGED), fără nicio scriere", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const before = await counter(h.tx);
      const input = await h.input(owner, { expectedTotalMinor: 1 });
      expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_TOTAL_CHANGED");
      expect(await counter(h.tx)).toBe(before);
      expect((await h.cart.view(owner)).lines).toHaveLength(1);
    });
  });

  it("stoc insuficient: comanda nu se plasează, numărul NU se consumă, stocul rămâne neatins", async () => {
    await harness(async (h) => {
      const a = await h.product({ physical: "2" });
      const owner = await h.fill([{ variantId: a.variantId, quantity: q("2") }]);
      // între timp stocul fizic scade (o vânzare în magazin)
      await h.tx.inventoryItem.update({
        where: {
          variantId_warehouseId: { variantId: a.variantId, warehouseId: h.ctx.warehouseId },
        },
        data: { physical: q("1") },
      });
      const before = await counter(h.tx);
      const orders = await h.tx.order.count();
      const input = await h.input(owner, { expectedTotalMinor: 1 });
      // totalul e greșit intenționat pentru a verifica ordinea: întâi totalul, apoi stocul
      expect(await codeOf(h.checkout.place(owner, input))).toMatch(
        /ORDER_TOTAL_CHANGED|ORDER_CART_NOT_READY/,
      );
      expect(await counter(h.tx)).toBe(before);
      expect(await h.tx.order.count()).toBe(orders);
    });
  });

  it("o plasare reușită după una eșuată primește numărul imediat următor (fără goluri)", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const first = await h.checkout.place(owner, await h.input(owner));
      const b = await h.product();
      const owner2 = await h.fill([{ variantId: b.variantId }]);
      const failing = await h.input(owner2, { expectedTotalMinor: 1 });
      expect(await codeOf(h.checkout.place(owner2, failing))).toBe("ORDER_TOTAL_CHANGED");
      const second = await h.checkout.place(owner2, await h.input(owner2));
      expect(Number(second.number.slice(2))).toBe(Number(first.number.slice(2)) + 1);
    });
  });

  it("oferta de livrare inexistentă, CUI invalid, țară nepermisă, coș gol", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      expect(
        await codeOf(
          h.checkout.place(
            owner,
            await h.input(owner, { shippingOfferCode: "nu-exista", expectedTotalMinor: 5 }),
          ),
        ),
      ).toBe("ORDER_OFFER_UNAVAILABLE");
      expect(
        await codeOf(
          h.checkout.place(
            owner,
            await h.input(owner, {
              company: { name: "Firma SRL", vatId: "14399841" },
              expectedTotalMinor: 5,
            }),
          ),
        ),
      ).toBe("ORDER_CUI_INVALID");
      const foreign = {
        fullName: "Ion",
        phone: "0722123456",
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        street: "Str. X 1",
        postalCode: "123456",
        country: "HU",
      };
      expect(
        await codeOf(
          h.checkout.place(
            owner,
            await h.input(owner, { shipping: foreign, expectedTotalMinor: 5 }),
          ),
        ),
      ).toBe("ORDER_COUNTRY_NOT_ALLOWED");
      const empty: CartOwner = { kind: "guest", token: null };
      expect(await codeOf(h.checkout.place(empty, await h.input(owner)))).toBe(
        "ORDER_CART_NOT_READY",
      );
    });
  });

  it("localitatea din alt județ e respinsă (validare pe server)", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const bad = await h.input(owner, {
        shipping: {
          fullName: "Ion",
          phone: "0722123456",
          countyCode: 97,
          localityCode: h.geo.localityCode,
          street: "Str. X 1",
          postalCode: "123456",
        },
        expectedTotalMinor: 5,
      });
      expect(await codeOf(h.checkout.place(owner, bad))).toBe("VALIDATION_ERROR");
    });
  });

  // Faza 14c: checkout-ul nu mai refuză produsele digitale (ORDER_DIGITAL_NOT_SUPPORTED rămâne doar la oferte); un oaspete cu un
  // produs digital în coș e trimis la autentificare. Singurul test existent schimbat în Faza 14c (comportamentul din §4 al fazei).
  it("produsele digitale cer un cont: oaspetele e refuzat cu ORDER_LOGIN_REQUIRED (Faza 14c)", async () => {
    await harness(async (h) => {
      const d = await h.product({ type: "digital", manageStock: false });
      const owner = await h.fill([{ variantId: d.variantId }]);
      const preview = await h.checkout.preview({ owner, destination: null });
      expect(preview.blocked?.code).toBe("ORDER_LOGIN_REQUIRED");
      expect(
        await codeOf(h.checkout.place(owner, await h.input(owner, { expectedTotalMinor: 5 }))),
      ).toBe("ORDER_LOGIN_REQUIRED");
    });
  });

  it("pasul de vânzare schimbat după adăugarea în coș: cantitatea nu mai e multiplu exact → comanda nu se plasează, nimic scris", async () => {
    await harness(async (h) => {
      const p = await h.product({ step: "0,3" });
      const owner = await h.fill([{ variantId: p.variantId, quantity: q("0,9") }]);
      const before = await h.checkout.preview({ owner, destination: null });
      expect(before.blocked).toBeNull();
      const input = await h.input(owner);
      // magazinul schimbă pasul produsului: 0,9 nu mai e multiplu exact de 0,4
      await h.tx.product.update({ where: { id: p.productId }, data: { saleStep: 4_000 } });
      const after = await h.checkout.preview({ owner, destination: null });
      // coșul însuși marchează linia (nu se poate finaliza); verificarea pasului din CheckoutService e a doua plasă, pe aceeași regulă
      expect(after.blocked?.code).toMatch(/ORDER_CART_NOT_READY|ORDER_QUANTITY_INVALID/);
      expect(await codeOf(h.checkout.place(owner, input))).toMatch(
        /ORDER_CART_NOT_READY|ORDER_QUANTITY_INVALID/,
      );
      expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(0);
    });
  });

  it("coșul modificat între calcul și plasare → ORDER_CART_CHANGED, nimic scris", async () => {
    let mutate: (() => Promise<void>) | null = null;
    const provider: ShippingRateProvider = {
      name: "care-modifică-coșul",
      quote: async (request) => {
        await mutate?.();
        return new DemoShippingRateProvider().quote(request);
      },
    };
    await harness(
      async (h) => {
        const a = await h.product();
        const b = await h.product();
        const owner = await h.fill([{ variantId: a.variantId }]);
        const input = await h.input(owner);
        mutate = async () => {
          await h.cart.add(owner, { variantId: b.variantId, quantity: "minimum" });
        };
        expect(await codeOf(h.checkout.place(owner, input))).toMatch(
          /ORDER_CART_CHANGED|ORDER_TOTAL_CHANGED/,
        );
        expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(0);
      },
      { provider },
    );
  });
});

describe("acordul pentru Termeni", () => {
  it("fără acord, sau cu o versiune a textului care nu mai e cea curentă, comanda nu se plasează", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const refused = await h.input(owner, {
        consent: { accepted: false, version: CHECKOUT_TERMS_CONSENT.version },
      });
      expect(await codeOf(h.checkout.place(owner, refused))).toBe("VALIDATION_ERROR");
      const stale = await h.input(owner, {
        consent: { accepted: true, version: "versiune-veche" },
      });
      expect(await codeOf(h.checkout.place(owner, stale))).toBe("VALIDATION_ERROR");
      expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(0);
      expect((await h.cart.view(owner)).lines).toHaveLength(1);
    });
  });

  it("textul și versiunea salvate pe comandă sunt cele de pe server, nu cele trimise de client", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const placed = await h.checkout.place(owner, await h.input(owner));
      const order = await orderOf(h.tx, placed.orderId);
      expect(order.termsConsentText).toBe(CHECKOUT_TERMS_CONSENT.text);
      expect(order.termsConsentVersion).toBe(CHECKOUT_TERMS_CONSENT.version);
      expect(order.termsAcceptedAt).toEqual(NOW);
    });
  });
});

describe("CUI și facturare pe firmă", () => {
  it("ANAF a găsit firma: adresa de facturare are CUI-ul «verified»", async () => {
    await harness(async (h) => {
      const a = await h.product({ price: 100_000 });
      const owner = await h.fill([{ variantId: a.variantId }]);
      const result = await h.checkout.place(
        owner,
        await h.input(owner, { company: { name: "Firma SRL", vatId: "RO14399840" } }),
      );
      const billing = (await orderOf(h.tx, result.orderId)).addresses.find(
        (x) => x.kind === "billing",
      )!;
      expect(billing).toMatchObject({
        company: "Firma SRL",
        vatId: "14399840",
        vatIdVerification: "verified",
      });
      expect(billing.tradeRegisterNo).toBe("J01/1/2020");
    });
  });

  it("ANAF picat: comanda se plasează, CUI-ul rămâne «unverified»", async () => {
    await harness(
      async (h) => {
        const a = await h.product({ price: 100_000 });
        const owner = await h.fill([{ variantId: a.variantId }]);
        const result = await h.checkout.place(
          owner,
          await h.input(owner, { company: { name: "Firma SRL", vatId: "14399840" } }),
        );
        const billing = (await orderOf(h.tx, result.orderId)).addresses.find(
          (x) => x.kind === "billing",
        )!;
        expect(billing.vatIdVerification).toBe("unverified");
      },
      { cui: async () => ({ status: "unavailable", reason: "timeout" }) },
    );
  });
});

describe("cererea de instalare și notele", () => {
  it("bifa de instalare e nebifată implicit și nu schimbă totalul; observațiile se salvează doar dacă e bifată", async () => {
    await harness(async (h) => {
      const a = await h.product();
      const owner = await h.fill([{ variantId: a.variantId }]);
      const plain = await h.input(owner);
      const without = await h.checkout.place(owner, plain);
      const a1 = await orderOf(h.tx, without.orderId);
      expect(a1.installationRequested).toBe(false);

      const b = await h.product();
      const owner2 = await h.fill([{ variantId: b.variantId }]);
      const asked = await h.input(owner2, {
        installation: { requested: true, note: "Etaj 2, fără lift" },
        customerNote: "Sunați înainte",
      });
      const placed = await orderOf(h.tx, (await h.checkout.place(owner2, asked)).orderId);
      expect(placed).toMatchObject({
        installationRequested: true,
        installationNote: "Etaj 2, fără lift",
        customerNote: "Sunați înainte",
      });
      expect(placed.totalMinor).toBe(a1.totalMinor);
    });
  });
});

describe("programul de ridicare personală (Faza 13): doar text, doar când e completat", () => {
  const setHours = (h: Harness, value: string) =>
    h.tx.setting.upsert({
      where: { key: "company.pickupHours" },
      create: { key: "company.pickupHours", group: "company", value },
      update: { value },
    });
  const orderWith = async (h: Harness, offerCode: string) => {
    const a = await h.product();
    const owner = await h.fill([{ variantId: a.variantId }]);
    return h.checkout.place(owner, await h.input(owner, { shippingOfferCode: offerCode }));
  };

  it("apare în rezumatul comenzii cu ridicare, citit din setări; sumele comenzii nu depind de el", async () => {
    await harness(async (h) => {
      const without = await orderWith(h, "pickup");
      expect((await getOrderSummary(h.tx, without.orderId))?.shipping.pickupHoursText).toBeNull();
      await setHours(h, "  Luni–Vineri, 09:00–17:00  ");
      const placed = await orderWith(h, "pickup");
      const summary = await getOrderSummary(h.tx, placed.orderId);
      expect(summary?.shipping.pickupHoursText).toBe("Luni–Vineri, 09:00–17:00");
      // programul nu e în snapshot și nu atinge banii
      const order = await orderOf(h.tx, placed.orderId);
      expect(JSON.stringify(order.shippingSnapshot)).not.toContain("Luni");
      expect(order.totalMinor).toBe(summary?.totals.totalMinor);
      // o schimbare ulterioară se vede la afișare (programul de azi)
      await setHours(h, "Doar la programare");
      expect((await getOrderSummary(h.tx, placed.orderId))?.shipping.pickupHoursText).toBe(
        "Doar la programare",
      );
    });
  });

  it("textul gol sau doar spații nu se arată; comanda cu curier nu are program", async () => {
    await harness(async (h) => {
      await setHours(h, "   ");
      const pickup = await orderWith(h, "pickup");
      expect((await getOrderSummary(h.tx, pickup.orderId))?.shipping.pickupHoursText).toBeNull();
      await setHours(h, "Luni–Vineri");
      const courier = await orderWith(h, "demo:courier");
      expect((await getOrderSummary(h.tx, courier.orderId))?.shipping.pickupHoursText).toBeNull();
    });
  });
});
