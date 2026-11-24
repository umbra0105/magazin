import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  DIGITAL_CONSENT_DEFAULT_TEXT,
  DIGITAL_CONSENT_DEFAULT_VERSION,
} from "../digital/digital-rules";
import {
  DEMO_CARD,
  addTo,
  billingAddress,
  destination,
  digitalOnlyInput,
  digitalProduct,
  mixedInput,
  userWorld,
  type World,
} from "../test-utils/digital-checkout";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { CHECKOUT_TERMS_CONSENT } from "./consent";

/**
 * Faza 14c: checkout-ul pentru comenzi cu produse digitale, pe Postgres real, în tranzacție anulată. Cont verificat obligatoriu,
 * bifa legală separată de Termeni, coș 100% digital (fără adresă de livrare, fără transport, fără ramburs), coș mixt (transport
 * și prag de transport doar pe liniile fizice, ramburs permis), maxim o bucată pe linie digitală, fără stoc pe digital. Coșurile
 * fără produse digitale sunt păzite de testul de paritate (`checkout-parity`).
 */
const db = getDb();
afterAll(() => db.$disconnect());

const orderCount = (h: Harness) => h.tx.order.count();

describe("poarta contului (cont verificat obligatoriu)", () => {
  it("oaspetele cu un produs digital în coș: ORDER_LOGIN_REQUIRED la afișare și la plasare, nimic scris", async () => {
    await harness(async (h) => {
      const d = await digitalProduct(h);
      const owner = await h.fill([{ variantId: d.variantId }]);
      const before = await orderCount(h);
      const preview = await h.checkout.preview({ owner, destination: null });
      expect(preview.blocked?.code).toBe("ORDER_LOGIN_REQUIRED");
      const world = { h, userId: "", owner } as World;
      const input = await digitalOnlyInput(world);
      expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_LOGIN_REQUIRED");
      expect(await orderCount(h)).toBe(before);
      // coșul a rămas întreg: oaspetele îl păstrează după autentificare
      expect((await h.cart.view(owner)).lines).toHaveLength(1);
    });
  });

  it("contul cu emailul neverificat: ORDER_EMAIL_NOT_VERIFIED la afișare și la plasare", async () => {
    await harness(async (h) => {
      const world = await userWorld(h, false);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const before = await orderCount(h);
      expect(
        (await h.checkout.preview({ owner: world.owner, destination: null })).blocked?.code,
      ).toBe("ORDER_EMAIL_NOT_VERIFIED");
      const input = await digitalOnlyInput(world);
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_EMAIL_NOT_VERIFIED");
      expect(await orderCount(h)).toBe(before);
    });
  });

  it("contul verificat trece: previzualizarea nu mai e blocată", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      expect(
        (await h.checkout.preview({ owner: world.owner, destination: null })).blocked,
      ).toBeNull();
    });
  });

  it("coșul fără produse digitale: oaspetele și contul neverificat rămân ca înainte (fără poartă)", async () => {
    await harness(async (h) => {
      const p = await h.product();
      const guest = await h.fill([{ variantId: p.variantId }]);
      expect((await h.checkout.preview({ owner: guest, destination: null })).blocked).toBeNull();
      const world = await userWorld(h, false);
      await addTo(world, [{ variantId: p.variantId }]);
      expect(
        (await h.checkout.preview({ owner: world.owner, destination: null })).blocked,
      ).toBeNull();
    });
  });
});

describe("coș 100% digital", () => {
  it("se plasează fără adresă de livrare, fără transport și fără ofertă de livrare; bifa și contul se salvează ca date", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h, 30_000);
        await addTo(world, [{ variantId: d.variantId }]);
        const preview = await h.checkout.preview({
          owner: world.owner,
          destination: null,
          paymentMethod: "card",
        });
        expect(preview.blocked).toBeNull();
        expect(preview.digital).toMatchObject({ present: true, only: true });
        expect(preview.totals).toMatchObject({
          subtotalMinor: 30_000,
          shippingMinor: 0,
          codFeeMinor: 0,
          totalMinor: 30_000,
        });

        const result = await h.checkout.place(world.owner, await digitalOnlyInput(world));
        expect(result.replayed).toBe(false);
        expect(result.paymentId).not.toBeNull();
        const order = await orderOf(h.tx, result.orderId);
        expect(order).toMatchObject({
          customerId: world.userId,
          shippingMinor: 0,
          codFeeMinor: 0,
          shippingTaxMinor: 0,
          codFeeTaxMinor: 0,
          subtotalMinor: 30_000,
          totalMinor: 30_000,
          taxMinor: 5_207,
          shippingMethodCode: "digital",
          paymentMethod: "card",
          digitalConsentText: DIGITAL_CONSENT_DEFAULT_TEXT,
          digitalConsentVersion: DIGITAL_CONSENT_DEFAULT_VERSION,
          termsConsentVersion: CHECKOUT_TERMS_CONSENT.version,
        });
        expect(order.digitalConsentAt).toEqual(NOW);
        expect(order.shippingSnapshot).toMatchObject({
          code: "digital",
          kind: "digital",
          priceMinor: 0,
        });
        expect(order.lines.map((line) => line.isDigital)).toEqual([true]);
        // doar adresa de facturare; nicio adresă de livrare
        expect(order.addresses.map((address) => address.kind)).toEqual(["billing"]);
        // digitalul nu are stoc: nicio rezervare, nicio angajare
        expect(order.stockReservations).toHaveLength(0);
        expect(order.stockCommitments).toHaveLength(0);
        expect(order.events.map((event) => event.type)).toEqual(["order.placed"]);
        expect((await h.cart.view(world.owner)).lines).toHaveLength(0);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("rambursul nu există: ascuns la afișare și refuzat la plasare", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h);
        await addTo(world, [{ variantId: d.variantId }]);
        const preview = await h.checkout.preview({
          owner: world.owner,
          destination: null,
          paymentMethod: "card",
        });
        const methods = preview.methods?.map((entry) => entry.method) ?? [];
        expect(methods).toContain("card");
        expect(methods).toContain("bank_transfer");
        expect(methods).not.toContain("cod");
        const input = await digitalOnlyInput(world, {
          paymentMethod: "cod",
          expectedTotalMinor: 30_000,
        });
        expect(await codeOf(h.checkout.place(world.owner, input))).toBe(
          "ORDER_PAYMENT_METHOD_UNKNOWN",
        );
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("transfer bancar: comandă plasată, fără rezervare de stoc, cu expirarea transferului păstrată", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const result = await h.checkout.place(
        world.owner,
        await digitalOnlyInput(world, { paymentMethod: "bank_transfer" }),
      );
      const order = await orderOf(h.tx, result.orderId);
      expect(order.paymentMethod).toBe("bank_transfer");
      expect(order.reservationExpiresAt).not.toBeNull();
      expect(order.stockReservations).toHaveLength(0);
      expect(order.stockCommitments).toHaveLength(0);
      expect(order.addresses.map((address) => address.kind)).toEqual(["billing"]);
    });
  });

  it("nu cere livrare: adresa și oferta de livrare lipsesc și sunt ignorate dacă vin", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const input = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        shippingOfferCode: "demo:courier",
        shipping: {
          fullName: "Ion",
          phone: "0722123456",
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          street: "Str. X 1",
          postalCode: "123456",
        },
      });
      const result = await h.checkout.place(world.owner, input);
      const order = await orderOf(h.tx, result.orderId);
      expect(order.shippingMethodCode).toBe("digital");
      expect(order.shippingMinor).toBe(0);
      expect(order.addresses.map((address) => address.kind)).toEqual(["billing"]);
    });
  });

  it("facturarea nu poate fi «aceeași cu livrarea»: nu există livrare", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const input = await digitalOnlyInput(world, { billing: { sameAsShipping: true } });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("VALIDATION_ERROR");
    });
  });

  it("adresa de facturare dintr-o țară nepermisă e refuzată", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h);
        await addTo(world, [{ variantId: d.variantId }]);
        const input = await digitalOnlyInput(world, {
          billing: { sameAsShipping: false, address: { ...billingAddress(h), country: "DE" } },
        });
        expect(await codeOf(h.checkout.place(world.owner, input))).toBe(
          "ORDER_COUNTRY_NOT_ALLOWED",
        );
      },
      { settings: { allowedCountries: ["RO"] } },
    );
  });

  it("firma la facturare: datele firmei ajung pe adresa de facturare", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const result = await h.checkout.place(
        world.owner,
        await digitalOnlyInput(world, {
          paymentMethod: "bank_transfer",
          company: { name: "FIRMA TEST SRL", vatId: "RO14399840" },
        }),
      );
      const order = await orderOf(h.tx, result.orderId);
      expect(order.addresses).toHaveLength(1);
      expect(order.addresses[0]).toMatchObject({ kind: "billing", vatId: "14399840" });
    });
  });

  it("totalul schimbat între afișare și plasare: ORDER_TOTAL_CHANGED, nimic scris", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const before = await orderCount(h);
      const input = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        expectedTotalMinor: 29_999,
      });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_TOTAL_CHANGED");
      expect(await orderCount(h)).toBe(before);
    });
  });

  it("aceeași cheie de idempotență: a doua cerere întoarce comanda, fără comandă nouă", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const input = await digitalOnlyInput(world, { paymentMethod: "bank_transfer" });
      const first = await h.checkout.place(world.owner, input);
      const second = await h.checkout.place(world.owner, input);
      expect(second).toMatchObject({ orderId: first.orderId, replayed: true });
      expect(await h.tx.order.count({ where: { id: first.orderId } })).toBe(1);
    });
  });
});

describe("bifa legală (renunțarea la dreptul de retragere)", () => {
  it("lipsa bifei e refuzată pe server, nimic scris", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const before = await orderCount(h);
      const input = await digitalOnlyInput(world, { paymentMethod: "bank_transfer" });
      delete (input as { digitalConsent?: unknown }).digitalConsent;
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe(
        "ORDER_DIGITAL_CONSENT_REQUIRED",
      );
      expect(await orderCount(h)).toBe(before);
    });
  });

  it("bifa nebifată (accepted: false) sau cu o versiune veche e refuzată", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const unchecked = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        digitalConsent: { accepted: false, version: DIGITAL_CONSENT_DEFAULT_VERSION },
      });
      expect(["ORDER_DIGITAL_CONSENT_REQUIRED", "VALIDATION_ERROR"]).toContain(
        await codeOf(h.checkout.place(world.owner, unchecked)),
      );
      const stale = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        digitalConsent: { accepted: true, version: "versiune-veche" },
      });
      expect(await codeOf(h.checkout.place(world.owner, stale))).toBe(
        "ORDER_DIGITAL_CONSENT_REQUIRED",
      );
    });
  });

  it("acordarea Termenilor NU ține loc de bifa legală: sunt două acorduri separate", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const input = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        digitalConsent: undefined,
        consent: { accepted: true, version: CHECKOUT_TERMS_CONSENT.version },
      });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe(
        "ORDER_DIGITAL_CONSENT_REQUIRED",
      );
    });
  });

  it("textul din setarea `digital.consentText` se salvează exact, cu versiune derivată din el", async () => {
    await harness(async (h) => {
      // upsert: pe `ecom_test` seed-uită rândul poate exista deja (testele nu presupun seed, nici absența lui)
      await h.tx.setting.upsert({
        where: { key: "digital.consentText" },
        create: {
          key: "digital.consentText",
          group: "digital",
          value: "Cer livrarea imediată a cursului.",
        },
        update: { value: "Cer livrarea imediată a cursului." },
      });
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      // versiunea implicită nu mai e cea curentă
      const stale = await digitalOnlyInput(world, { paymentMethod: "bank_transfer" });
      expect(await codeOf(h.checkout.place(world.owner, stale))).toBe(
        "ORDER_DIGITAL_CONSENT_REQUIRED",
      );
      const { consentSnapshot } = await import("../digital/digital-rules");
      const snapshot = consentSnapshot("Cer livrarea imediată a cursului.");
      const input = await digitalOnlyInput(world, {
        paymentMethod: "bank_transfer",
        digitalConsent: { accepted: true, version: snapshot.version },
      });
      const result = await h.checkout.place(world.owner, input);
      const order = await orderOf(h.tx, result.orderId);
      expect(order.digitalConsentText).toBe("Cer livrarea imediată a cursului.");
      expect(order.digitalConsentVersion).toBe(snapshot.version);
    });
  });

  it("la o comandă FĂRĂ produse digitale bifa trimisă e ignorată: nimic de bifă pe comandă, nicio legătură cu un cont", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const p = await h.product();
      await addTo(world, [{ variantId: p.variantId }]);
      const input = await mixedInput(world);
      const result = await h.checkout.place(world.owner, input);
      const order = await orderOf(h.tx, result.orderId);
      expect(order.customerId).toBeNull();
      expect(order.digitalConsentAt).toBeNull();
      expect(order.digitalConsentText).toBeNull();
      expect(order.digitalConsentVersion).toBeNull();
      expect(order.lines.map((line) => line.isDigital)).toEqual([false]);
    });
  });
});

describe("coș mixt (fizic + digital)", () => {
  it("transportul se calculează doar pe liniile fizice: același tarif ca pentru coșul doar fizic", async () => {
    await harness(async (h) => {
      const physical = await h.product({ price: 10_000, weightGrams: 2_000 });
      const d = await digitalProduct(h, 300_000);
      const guestPhysical = await h.fill([{ variantId: physical.variantId }]);
      const baseline = await h.checkout.preview({
        owner: guestPhysical,
        destination: destination(h),
        offerCode: "demo:courier",
        paymentMethod: "cod",
      });

      const world = await userWorld(h);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const mixed = await h.checkout.preview({
        owner: world.owner,
        destination: destination(h),
        offerCode: "demo:courier",
        paymentMethod: "cod",
      });
      expect(mixed.blocked).toBeNull();
      expect(mixed.digital).toMatchObject({ present: true, only: false });
      expect(mixed.totals?.shippingMinor).toBe(baseline.totals?.shippingMinor);
      expect(mixed.totals?.codFeeMinor).toBe(baseline.totals?.codFeeMinor);
      expect(mixed.totals?.subtotalMinor).toBe(10_000 + 300_000);
      // oferta de livrare e cea a coletului fizic (nicio greutate din cursul digital)
      expect(mixed.shipping?.offers.map((offer) => [offer.code, offer.priceMinor])).toEqual(
        baseline.shipping?.offers.map((offer) => [offer.code, offer.priceMinor]),
      );
    });
  });

  it.each([
    ["cu 1 ban sub prag", 49_999, false],
    ["exact la prag", 50_000, true],
    ["cu 1 ban peste prag", 50_001, true],
  ])(
    "pragul de transport gratuit ține cont doar de liniile fizice (%s)",
    async (_name, physicalPrice, free) => {
      await harness(
        async (h) => {
          const physical = await h.product({ price: physicalPrice });
          // un curs scump alături: dacă ar conta în prag, transportul ar fi mereu gratuit
          const d = await digitalProduct(h, 500_000);
          const world = await userWorld(h);
          await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
          const preview = await h.checkout.preview({
            owner: world.owner,
            destination: destination(h),
            offerCode: "demo:courier",
            paymentMethod: "bank_transfer",
          });
          expect(preview.shipping?.freeShipping.eligible).toBe(free);
          expect(preview.totals?.shippingMinor === 0).toBe(free);
        },
        { shipping: { freeShippingThresholdMinor: 50_000 } },
      );
    },
  );

  it("un curs scump nu face gratuit transportul unei șurubelnițe ieftine (transportul rămâne plătit)", async () => {
    await harness(
      async (h) => {
        const physical = await h.product({ price: 4_900 });
        const d = await digitalProduct(h, 30_000);
        const world = await userWorld(h);
        await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
        const preview = await h.checkout.preview({
          owner: world.owner,
          destination: destination(h),
          offerCode: "demo:courier",
          paymentMethod: "cod",
        });
        expect(preview.view.totals.totalMinor).toBe(34_900);
        expect(preview.shipping?.freeShipping).toEqual({
          eligible: false,
          reason: "below_threshold",
        });
        expect(preview.totals?.shippingMinor).toBeGreaterThan(0);
      },
      { shipping: { freeShippingThresholdMinor: 30_000 } },
    );
  });

  it("se plasează cu ramburs: ramburs permis, adresă de livrare + facturare, stoc angajat doar pentru produsul fizic", async () => {
    await harness(async (h) => {
      const physical = await h.product({ price: 10_000 });
      const d = await digitalProduct(h, 20_000);
      const world = await userWorld(h);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const result = await h.checkout.place(world.owner, await mixedInput(world));
      const order = await orderOf(h.tx, result.orderId);
      expect(order).toMatchObject({
        customerId: world.userId,
        paymentMethod: "cod",
        status: "confirmed",
        fulfillmentStatus: "unfulfilled",
        shippingMethodCode: "demo:courier",
        digitalConsentText: DIGITAL_CONSENT_DEFAULT_TEXT,
      });
      expect(order.shippingMinor).toBeGreaterThan(0);
      expect(order.addresses.map((address) => address.kind).sort()).toEqual([
        "billing",
        "shipping",
      ]);
      expect(order.lines.map((line) => line.isDigital).sort()).toEqual([false, true]);
      // stocul: o singură angajare (linia fizică); digitalul nu are stoc
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.stockCommitments[0]?.quantity).toBe(q("1"));
      expect(order.stockReservations).toHaveLength(0);
      const item = await h.tx.inventoryItem.findFirst({ where: { variantId: d.variantId } });
      expect(item?.committed ?? 0n).toBe(0n);
    });
  });

  it("coșul mixt cere adresă și ofertă de livrare: fără ele, comanda nu se plasează", async () => {
    await harness(async (h) => {
      const physical = await h.product({ price: 10_000 });
      const d = await digitalProduct(h, 20_000);
      const world = await userWorld(h);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const before = await orderCount(h);
      const full = await mixedInput(world);
      const noShipping = { ...full };
      delete (noShipping as { shipping?: unknown }).shipping;
      expect(await codeOf(h.checkout.place(world.owner, noShipping))).toBe("VALIDATION_ERROR");
      const noOffer = { ...full };
      delete (noOffer as { shippingOfferCode?: unknown }).shippingOfferCode;
      expect(await codeOf(h.checkout.place(world.owner, noOffer))).toBe("VALIDATION_ERROR");
      expect(await orderCount(h)).toBe(before);
    });
  });

  it("coșul fizic (fără digital) cere în continuare adresă și ofertă de livrare", async () => {
    await harness(async (h) => {
      const p = await h.product();
      const owner = await h.fill([{ variantId: p.variantId }]);
      const full = await h.input(owner);
      const noShipping = { ...full };
      delete (noShipping as { shipping?: unknown }).shipping;
      expect(await codeOf(h.checkout.place(owner, noShipping))).toBe("VALIDATION_ERROR");
    });
  });

  it("card: rezervarea (15 minute) privește doar linia fizică; digitalul nu rezervă nimic", async () => {
    await harness(
      async (h) => {
        const physical = await h.product({ price: 10_000 });
        const d = await digitalProduct(h, 20_000);
        const world = await userWorld(h);
        await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
        const result = await h.checkout.place(
          world.owner,
          await mixedInput(world, { paymentMethod: "card" }),
        );
        const order = await orderOf(h.tx, result.orderId);
        expect(order.stockReservations).toHaveLength(1);
        expect(order.stockReservations[0]?.variantId).toBe(physical.variantId);
        expect(order.stockCommitments).toHaveLength(0);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });
});

describe("maxim o bucată pe linie digitală, la plasare", () => {
  it("un coș vechi cu 2 bucăți digitale nu se plasează (ORDER_DIGITAL_QUANTITY), nimic scris", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const input = await digitalOnlyInput(world, { paymentMethod: "bank_transfer" });
      // după ce clientul a văzut totalul, cantitatea din bază devine 2 (coș vechi sau modificare pe ocolite)
      await h.tx.cartItem.updateMany({
        where: { variantId: d.variantId },
        data: { quantity: q("2") },
      });
      const before = await orderCount(h);
      expect(
        (await h.checkout.preview({ owner: world.owner, destination: null })).blocked?.code,
      ).toBe("ORDER_DIGITAL_QUANTITY");
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_DIGITAL_QUANTITY");
      expect(await orderCount(h)).toBe(before);
    });
  });
});

describe("regulile coșului fără produse digitale rămân neschimbate", () => {
  it("contul logat care comandă doar produse fizice: comandă fără customerId (ca înainte)", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const p = await h.product();
      await addTo(world, [{ variantId: p.variantId }]);
      const result = await h.checkout.place(world.owner, await h.input(world.owner));
      const order = await orderOf(h.tx, result.orderId);
      expect(order.customerId).toBeNull();
      expect(order.shippingMethodCode).toBe("demo:courier");
    });
  });
});
