import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { NOW, codeOf, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { cardHarness } from "../test-utils/payment-fixtures";
import { OfferService, type OfferDraftInput } from "./offer-service";

/**
 * Oferta de plată (Faza 11, decizia A), pe Postgres real, în tranzacție anulată: liniile și totalurile se ÎNGHEAȚĂ la creare, la
 * plată serverul recalculează (prețul, transportul, TVA-ul, stocul), conversia trece prin același `CheckoutService`, o ofertă
 * dă o singură comandă, iar jetonul invalid/expirat/anulat nu se deosebește de cel necunoscut. Concurența cu date comise e în
 * `offer-concurrency`.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { id: "user-1", label: "Manager Test" };
const CONSENT = { accepted: true as const, version: CHECKOUT_TERMS_CONSENT.version };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Contorul poate avea valori comise de alte teste: numărul următor se calculează din starea de acum, nu din «0001». */
async function nextNumber(h: Harness): Promise<string> {
  const row = await h.tx.orderOfferCounter.findUnique({ where: { id: "offer" } });
  return `OF-${String((row?.lastValue ?? 0) + 1).padStart(4, "0")}`;
}
const numberAfter = (number: string): string =>
  `OF-${String(Number(number.slice(3)) + 1).padStart(4, "0")}`;

interface Env {
  h: Harness;
  clock: { now: Date };
  offers: OfferService;
  draft: (lines: OfferDraftInput["lines"], over?: Partial<OfferDraftInput>) => OfferDraftInput;
}

async function withOffers<T>(
  fn: (env: Env) => Promise<T>,
  over: { validityHours?: number; card?: boolean } = {},
): Promise<T> {
  const run = (h: Harness) => {
    const clock = { now: NOW };
    const offers = new OfferService({
      db: h.tx,
      cart: h.cart,
      checkout: h.checkout,
      readSettings: async () => ({
        validityHours: over.validityHours ?? 72,
        numberPrefix: "OF-",
      }),
      now: () => clock.now,
    });
    const draft: Env["draft"] = (lines, extra = {}) => ({
      email: "Client@Exemplu.RO",
      phone: "0722 123 456",
      shipping: {
        fullName: "Ion Popescu",
        phone: "0722123456",
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        street: "Str. Exemplu 1",
        postalCode: "123456",
      },
      billing: { sameAsShipping: true },
      company: null,
      shippingOfferCode: "demo:courier",
      lines,
      ...extra,
    });
    return fn({ h, clock, offers, draft });
  };
  return over.card === false
    ? (await import("../test-utils/checkout-fixtures")).harness(run)
    : cardHarness(run);
}

describe("crearea ofertei", () => {
  it("îngheață liniile și totalurile calculate de motor; în bază stă doar amprenta jetonului", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900 });
      const b = await h.product({ price: 5_050 });
      const expectedNumber = await nextNumber(h);
      const created = await offers.create(
        draft([
          { variantId: a.variantId, quantity: "1" },
          { variantId: b.variantId, quantity: "3" },
        ]),
        ACTOR,
      );
      expect(created.number).toBe(expectedNumber);
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.expiresAt).toEqual(new Date(NOW.getTime() + 72 * 3_600_000));

      const row = await h.tx.orderOffer.findUniqueOrThrow({
        where: { id: created.offerId },
        include: { lines: { orderBy: { position: "asc" } }, events: true },
      });
      expect(row.tokenHash).toBe(sha256(created.token));
      expect(
        JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain(created.token);
      expect(row).toMatchObject({
        status: "active",
        email: "client@exemplu.ro",
        phone: "+40722123456",
        shippingOfferCode: "demo:courier",
        shippingKind: "courier",
        taxRateBps: 2100,
        creatorId: ACTOR.id,
        creatorLabel: ACTOR.label,
        subtotalMinor: 19_900 + 3 * 5_050,
      });
      expect(row.totalMinor).toBe(row.subtotalMinor + row.shippingMinor);
      expect(row.lines).toHaveLength(2);
      expect(row.lines[0]).toMatchObject({
        variantId: a.variantId,
        sku: a.sku,
        unitPriceMinor: 19_900,
        lineTotalMinor: 19_900,
        position: 0,
      });
      expect(row.lines[1]).toMatchObject({ unitPriceMinor: 5_050, lineTotalMinor: 15_150 });
      expect(row.events.map((e) => e.type)).toEqual(["offer.created"]);
      // coșul temporar al adminului nu rămâne în bază
      expect(
        await h.tx.cart.count({ where: { items: { some: { variantId: a.variantId } } } }),
      ).toBe(0);
    });
  });

  it("numerele ofertelor sunt consecutive și au prefixul propriu, diferit de cel al comenzilor", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product();
      const expected = await nextNumber(h);
      const one = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);
      const two = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);
      expect(one.number).toBe(expected);
      expect(two.number).toBe(numberAfter(expected));
      expect(one.token).not.toBe(two.token);
    });
  });

  it("refuză produsele digitale, coșul gol, aceeași variantă de două ori și o ofertă de livrare inexistentă", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const physical = await h.product();
      const digital = await h.product({ type: "digital" });
      expect(
        await codeOf(
          offers.create(draft([{ variantId: digital.variantId, quantity: "1" }]), ACTOR),
        ),
      ).toBe("OFFER_DIGITAL_NOT_SUPPORTED");
      expect(await codeOf(offers.create(draft([]), ACTOR))).toBe("OFFER_INVALID");
      expect(
        await codeOf(
          offers.create(
            draft([
              { variantId: physical.variantId, quantity: "1" },
              { variantId: physical.variantId, quantity: "1" },
            ]),
            ACTOR,
          ),
        ),
      ).toBe("OFFER_INVALID");
      expect(
        await codeOf(
          offers.create(
            draft([{ variantId: physical.variantId, quantity: "1" }], {
              shippingOfferCode: "nu-exista",
            }),
            ACTOR,
          ),
        ),
      ).toBe("OFFER_NOT_PAYABLE");
      expect(await h.tx.orderOffer.count()).toBe(0);
    });
  });

  it("refuză cantitatea peste stoc (aceeași regulă ca în coș)", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "2" });
      expect(
        await codeOf(offers.create(draft([{ variantId: a.variantId, quantity: "5" }]), ACTOR)),
      ).toBe("CART_EXCEEDS_AVAILABLE");
    });
  });

  it("fără furnizor de card activ nu se poate crea o ofertă (e doar cu card)", async () => {
    await withOffers(
      async ({ h, offers, draft }) => {
        const a = await h.product();
        expect(
          await codeOf(offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR)),
        ).toBe("OFFER_CARD_UNAVAILABLE");
      },
      { card: false },
    );
  });
});

describe("pagina publică: jetonul", () => {
  it("jetonul necunoscut, expirat, anulat sau stricat dă ACELAȘI răspuns (nu se deosebesc din afară)", async () => {
    await withOffers(async ({ h, clock, offers, draft }) => {
      const a = await h.product();
      const cancelled = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      const expired = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      await offers.cancel(cancelled.offerId, ACTOR);
      clock.now = new Date(NOW.getTime() + 73 * 3_600_000);
      const live = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);

      const unavailable = [
        "x".repeat(43),
        "scurt",
        "",
        cancelled.token,
        expired.token,
        `${live.token}x`,
      ];
      for (const token of unavailable) {
        expect(await offers.publicView(token), token).toBeNull();
        const error = await offers.convert(token, CONSENT).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "OFFER_UNAVAILABLE" });
        expect((error as Error).message).toBe(
          ((await offers.convert("x".repeat(43), CONSENT).catch((e: unknown) => e)) as Error)
            .message,
        );
      }
      const view = await offers.publicView(live.token);
      expect(view).toMatchObject({ number: live.number, totalMinor: live.totals.totalMinor });
    });
  });

  it("vederea publică nu conține date de achiziție, amprenta jetonului sau identitatea creatorului", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product();
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      const text = JSON.stringify(await offers.publicView(created.token));
      expect(text).not.toContain("tokenHash");
      expect(text).not.toContain(sha256(created.token));
      expect(text).not.toContain(ACTOR.label);
      expect(text).not.toContain(ACTOR.id);
      expect(text.toLowerCase()).not.toContain("costprice");
    });
  });
});

describe("conversia: recalculare la plată", () => {
  it("fără nicio schimbare: comandă reală cu card, totalul înghețat, consimțământul salvat, stoc rezervat", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900, physical: "10" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "2" }]),
        ACTOR,
      );

      const result = await offers.convert(created.token, CONSENT);
      expect(result.replayed).toBe(false);
      expect(result.paymentId).not.toBeNull();

      const order = await orderOf(h.tx, result.orderId);
      expect(order).toMatchObject({
        paymentMethod: "card",
        status: "pending",
        totalMinor: created.totals.totalMinor,
        email: "client@exemplu.ro",
        termsConsentVersion: CHECKOUT_TERMS_CONSENT.version,
        termsConsentText: CHECKOUT_TERMS_CONSENT.text,
        customerId: null,
      });
      expect(order.termsAcceptedAt).toEqual(NOW);
      expect(order.lines).toHaveLength(1);
      expect(order.lines[0]).toMatchObject({ unitPriceMinor: 19_900, lineTotalMinor: 39_800 });
      expect(order.stockReservations.length).toBeGreaterThan(0);
      expect(order.events.map((e) => e.type)).toContain("order.from_offer");
      expect(JSON.stringify(order.events)).not.toContain(created.token);

      const offer = await h.tx.orderOffer.findUniqueOrThrow({
        where: { id: created.offerId },
        include: { events: true },
      });
      expect(offer).toMatchObject({ status: "converted", convertedOrderId: result.orderId });
      expect(offer.convertedAt).toEqual(NOW);
      expect(offer.events.map((e) => e.type)).toContain("offer.converted");
    });
  });

  it("a doua plată pe același link întoarce aceeași comandă, fără o comandă nouă și fără a doua rezervare", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "10" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      const first = await offers.convert(created.token, CONSENT);
      const second = await offers.convert(created.token, CONSENT);
      expect(second.orderId).toBe(first.orderId);
      expect(second.replayed).toBe(true);
      expect(
        await h.tx.order.count({ where: { email: "client@exemplu.ro", paymentMethod: "card" } }),
      ).toBe(1);
      expect(await h.tx.stockReservation.count({ where: { refId: first.orderId } })).toBe(1);
    });
  });

  it("fără bifa Termenilor sau cu textul altei versiuni nu se plătește, iar oferta rămâne activă", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product();
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      expect(await codeOf(offers.convert(created.token, { accepted: false } as never))).toBe(
        "VALIDATION_ERROR",
      );
      expect(await codeOf(offers.convert(created.token, { accepted: true, version: "alta" }))).toBe(
        "VALIDATION_ERROR",
      );
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).status,
      ).toBe("active");
      expect(
        await h.tx.order.count({ where: { email: "client@exemplu.ro", paymentMethod: "card" } }),
      ).toBe(0);
    });
  });

  it("prețul s-a schimbat după creare: oferta devine «stale», nu se creează comandă și adminii sunt anunțați", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900 });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      await h.tx.productVariant.update({ where: { id: a.variantId }, data: { price: 25_000 } });

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      const offer = await h.tx.orderOffer.findUniqueOrThrow({
        where: { id: created.offerId },
        include: { events: true },
      });
      expect(offer).toMatchObject({ status: "stale", staleReason: "price" });
      expect(offer.staleAt).toEqual(NOW);
      expect(offer.events.map((e) => e.type)).toContain("offer.stale");
      expect(
        await h.tx.order.count({ where: { email: "client@exemplu.ro", paymentMethod: "card" } }),
      ).toBe(0);
      // totalurile înghețate rămân cele văzute de client
      expect(offer.totalMinor).toBe(created.totals.totalMinor);

      const notes = await h.tx.adminNotification.findMany({ where: { kind: "offer_stale" } });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ permission: "orders.offers" });
      expect(notes[0]!.href).toBe(`/admin/comenzi/oferte/${created.offerId}`);
      expect(JSON.stringify(notes)).not.toContain("client@exemplu.ro");

      // o ofertă «stale» nu se plătește nici la încercarea următoare, și nu mai notifică a doua oară
      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      expect(await h.tx.adminNotification.count({ where: { kind: "offer_stale" } })).toBe(1);
    });
  });

  it("transportul s-a schimbat (prag de transport gratuit nou): «stale» cu motivul «shipping»", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900 });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      expect(created.totals.shippingMinor).toBeGreaterThan(0);
      h.shippingSettings.freeShippingThresholdMinor = 1;

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).staleReason,
      ).toBe("shipping");
    });
  });

  it("cota de TVA s-a schimbat: «stale» cu motivul «tax»", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900 });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      h.settings.taxStandardRate = 19;

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).staleReason,
      ).toBe("tax");
    });
  });

  it("stocul s-a epuizat între timp: «stale» cu motivul «stock», fără comandă și fără rezervare", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "2" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "2" }]),
        ACTOR,
      );
      // alt client cumpără tot stocul (ramburs: angajat direct)
      const other = await h.fill([{ variantId: a.variantId, quantity: q("2") }]);
      await h.checkout.place(other, await h.input(other));

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).staleReason,
      ).toBe("stock");
      expect(
        await h.tx.order.count({ where: { email: "client@exemplu.ro", paymentMethod: "card" } }),
      ).toBe(0);
    });
  });

  it("produsul a fost retras din vânzare după creare: «stale» cu motivul «product»", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product();
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      await h.tx.product.update({ where: { id: a.productId }, data: { status: "archived" } });

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_STALE");
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).staleReason,
      ).toBe("product");
    });
  });

  it("cardul a fost dezactivat după creare: oferta nu se plătește, dar NU devine «stale»", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product();
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      h.settings.cardProvider = null;

      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_CARD_UNAVAILABLE");
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).status,
      ).toBe("active");
    });
  });

  it("clientul NU poate schimba nimic: conversia nu primește adrese, prețuri, cantități sau metoda de plată", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ price: 19_900, physical: "10" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }], { email: "client@exemplu.ro" }),
        ACTOR,
      );
      // câmpurile în plus sunt ignorate: tot ce se plasează vine din oferta înghețată
      const hostile = {
        ...CONSENT,
        email: "altcineva@exemplu.ro",
        paymentMethod: "cod",
        totalMinor: 1,
        shipping: { street: "Alta 9" },
      } as never;
      const result = await offers.convert(created.token, hostile);
      const order = await orderOf(h.tx, result.orderId);
      expect(order.email).toBe("client@exemplu.ro");
      expect(order.paymentMethod).toBe("card");
      expect(order.totalMinor).toBe(created.totals.totalMinor);
      expect(order.addresses.find((x) => x.kind === "shipping")?.street).toBe("Str. Exemplu 1");
    });
  });
});

describe("ciclul de viață", () => {
  it("anularea: doar oferta activă; o ofertă anulată nu se mai plătește, una convertită nu se mai anulează", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "10" });
      const one = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);
      await offers.cancel(one.offerId, ACTOR);
      const row = await h.tx.orderOffer.findUniqueOrThrow({
        where: { id: one.offerId },
        include: { events: true },
      });
      expect(row).toMatchObject({ status: "cancelled" });
      expect(row.cancelledAt).toEqual(NOW);
      expect(row.events.map((e) => e.type)).toContain("offer.cancelled");
      expect(await codeOf(offers.convert(one.token, CONSENT))).toBe("OFFER_UNAVAILABLE");
      expect(await codeOf(offers.cancel(one.offerId, ACTOR))).toBe("OFFER_STATE_INVALID");

      const two = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);
      await offers.convert(two.token, CONSENT);
      expect(await codeOf(offers.cancel(two.offerId, ACTOR))).toBe("OFFER_STATE_INVALID");
    });
  });

  it("expirarea (jobul): doar ofertele active cu termenul trecut; a doua rulare nu schimbă nimic", async () => {
    await withOffers(async ({ h, clock, offers, draft }) => {
      const a = await h.product({ physical: "10" });
      const old = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);
      const converted = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      await offers.convert(converted.token, CONSENT);
      clock.now = new Date(NOW.getTime() + 71 * 3_600_000);
      const fresh = await offers.create(draft([{ variantId: a.variantId, quantity: "1" }]), ACTOR);

      expect(await offers.expireDue()).toBe(0);
      clock.now = new Date(NOW.getTime() + 72 * 3_600_000);
      expect(await offers.expireDue()).toBe(1);
      expect(await offers.expireDue()).toBe(0);

      const status = async (id: string) =>
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(old.offerId)).toBe("expired");
      expect(await status(converted.offerId)).toBe("converted");
      expect(await status(fresh.offerId)).toBe("active");
      expect(
        await h.tx.orderOfferEvent.count({
          where: { offerId: old.offerId, type: "offer.expired" },
        }),
      ).toBe(1);
    });
  });

  it("o ofertă cu termenul trecut nu se plătește nici înainte să ruleze jobul", async () => {
    await withOffers(async ({ h, clock, offers, draft }) => {
      const a = await h.product();
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      clock.now = new Date(NOW.getTime() + 73 * 3_600_000);
      expect(await codeOf(offers.convert(created.token, CONSENT))).toBe("OFFER_UNAVAILABLE");
      expect(
        await h.tx.order.count({ where: { email: "client@exemplu.ro", paymentMethod: "card" } }),
      ).toBe(0);
    });
  });

  it("retrimiterea: jeton nou, cel vechi nu mai merge; valabilitatea nu se prelungește; doar oferta activă", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "10" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      const again = await offers.reissueToken(created.offerId, ACTOR);
      expect(again.token).not.toBe(created.token);
      expect(await offers.publicView(created.token)).toBeNull();
      expect(await offers.publicView(again.token)).not.toBeNull();
      expect(again.expiresAt).toEqual(created.expiresAt);
      expect(
        (await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } })).tokenHash,
      ).toBe(sha256(again.token));

      await offers.cancel(created.offerId, ACTOR);
      expect(await codeOf(offers.reissueToken(created.offerId, ACTOR))).toBe("OFFER_STATE_INVALID");
    });
  });

  it("jurnalul ofertei nu conține jetonul, emailul sau telefonul clientului", async () => {
    await withOffers(async ({ h, offers, draft }) => {
      const a = await h.product({ physical: "10" });
      const created = await offers.create(
        draft([{ variantId: a.variantId, quantity: "1" }]),
        ACTOR,
      );
      await offers.reissueToken(created.offerId, ACTOR);
      await offers.cancel(created.offerId, ACTOR);
      const events = await h.tx.orderOfferEvent.findMany({ where: { offerId: created.offerId } });
      const text = JSON.stringify(events);
      expect(text).not.toContain(created.token);
      expect(text).not.toContain("client@exemplu.ro");
      expect(text).not.toContain("0722");
    });
  });
});

describe("«Duplică» din comandă", () => {
  it("pregătește oferta din liniile comenzii, la prețurile de ACUM, cu adresa și contactul comenzii", async () => {
    await withOffers(async ({ h, offers }) => {
      const a = await h.product({ price: 19_900, physical: "10" });
      const owner = await h.fill([{ variantId: a.variantId, quantity: q("2") }]);
      const placed = await h.checkout.place(owner, await h.input(owner));
      await h.tx.productVariant.update({ where: { id: a.variantId }, data: { price: 21_000 } });

      const draft = await offers.draftFromOrder(placed.orderId);
      expect(draft).toMatchObject({
        email: "client@exemplu.ro",
        phone: "+40722123456",
        shippingOfferCode: "demo:courier",
        lines: [{ variantId: a.variantId, quantity: "2" }],
        shipping: { fullName: "Ion Popescu", street: "Str. Exemplu 1", postalCode: "123456" },
      });
      const created = await offers.create(draft, ACTOR);
      expect(created.totals.subtotalMinor).toBe(2 * 21_000);
    });
  });

  it("o comandă inexistentă nu se poate duplica", async () => {
    await withOffers(async ({ offers }) => {
      expect(await codeOf(offers.draftFromOrder("nu-exista"))).toBe("ORDER_NOT_FOUND");
    });
  });
});
