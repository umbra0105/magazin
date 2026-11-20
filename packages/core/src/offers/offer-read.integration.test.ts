import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, type Harness } from "../test-utils/checkout-fixtures";
import { cardHarness } from "../test-utils/payment-fixtures";
import { getOfferDetail, listOffers, searchOfferVariants } from "./offer-read";
import { OfferService } from "./offer-service";

/** Citirile adminului pentru oferte, pe Postgres real, în tranzacție anulată: listă, detaliu, date personale și căutarea de produse. */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { id: "user-1", label: "Manager Test" };

async function withOffers<T>(
  fn: (env: {
    h: Harness;
    offers: OfferService;
    create: (variantId: string) => ReturnType<OfferService["create"]>;
  }) => Promise<T>,
): Promise<T> {
  return cardHarness(async (h) => {
    const offers = new OfferService({
      db: h.tx,
      cart: h.cart,
      checkout: h.checkout,
      readSettings: async () => ({ validityHours: 72, numberPrefix: "OF-" }),
      now: () => NOW,
    });
    const create = (variantId: string) =>
      offers.create(
        {
          email: "client@exemplu.ro",
          phone: "0722123456",
          shipping: {
            fullName: "Ana Popescu",
            phone: "0722123456",
            countyCode: h.geo.countyCode,
            localityCode: h.geo.localityCode,
            street: "Str. Exemplu 1",
            postalCode: "123456",
          },
          billing: { sameAsShipping: true },
          company: null,
          shippingOfferCode: "demo:courier",
          lines: [{ variantId, quantity: "2" }],
        },
        ACTOR,
      );
    return fn({ h, offers, create });
  });
}

describe("lista ofertelor", () => {
  it("«deschise» = active sau «stale»; «toate» le arată și pe cele anulate; datele personale doar cu drept", async () => {
    await withOffers(async ({ h, offers, create }) => {
      const a = await h.product({ physical: "10" });
      const open = await create(a.variantId);
      const cancelled = await create(a.variantId);
      await offers.cancel(cancelled.offerId, ACTOR);
      const before = (await listOffers(h.tx, { view: "open" }, { pii: true })).total;

      const openRows = await listOffers(h.tx, { view: "open", pageSize: 100 }, { pii: true });
      expect(openRows.rows.map((r) => r.number)).toContain(open.number);
      expect(openRows.rows.map((r) => r.number)).not.toContain(cancelled.number);
      expect(openRows.total).toBe(before);
      const row = openRows.rows.find((r) => r.id === open.offerId);
      expect(row).toMatchObject({
        customerName: "Ana Popescu",
        email: "client@exemplu.ro",
        totalMinor: open.totals.totalMinor,
        status: "active",
        creatorLabel: ACTOR.label,
      });

      const all = await listOffers(h.tx, { view: "all", pageSize: 100 }, { pii: true });
      expect(all.rows.map((r) => r.number)).toContain(cancelled.number);

      const hidden = await listOffers(h.tx, { view: "all", pageSize: 100 }, { pii: false });
      const text = JSON.stringify(hidden);
      expect(text).not.toContain("client@exemplu.ro");
      expect(text).not.toContain("Ana Popescu");
    });
  });
});

describe("detaliul ofertei", () => {
  it("liniile, totalurile și cronologia; fără drept de date personale clientul lipsește", async () => {
    await withOffers(async ({ h, create }) => {
      const a = await h.product({ price: 19_900, physical: "10" });
      const created = await create(a.variantId);
      const detail = await getOfferDetail(h.tx, created.offerId, { pii: true });
      expect(detail).toMatchObject({
        number: created.number,
        status: "active",
        totalMinor: created.totals.totalMinor,
        shippingKind: "courier",
        customer: { email: "client@exemplu.ro", fullName: "Ana Popescu", phone: "+40722123456" },
      });
      expect(detail?.lines).toEqual([
        expect.objectContaining({
          sku: a.sku,
          quantity: "2",
          unitPriceMinor: 19_900,
          lineTotalMinor: 39_800,
        }),
      ]);
      expect(detail?.events.map((e) => e.type)).toEqual(["offer.created"]);

      const masked = await getOfferDetail(h.tx, created.offerId, { pii: false });
      expect(masked?.customer).toBeNull();
      expect(JSON.stringify(masked)).not.toContain("client@exemplu.ro");
      expect(await getOfferDetail(h.tx, "nu-exista", { pii: true })).toBeNull();
    });
  });

  it("detaliul nu conține jetonul sau amprenta lui", async () => {
    await withOffers(async ({ h, create }) => {
      const a = await h.product({ physical: "10" });
      const created = await create(a.variantId);
      const row = await h.tx.orderOffer.findUniqueOrThrow({ where: { id: created.offerId } });
      const text = JSON.stringify(await getOfferDetail(h.tx, created.offerId, { pii: true }));
      expect(text).not.toContain(created.token);
      expect(text).not.toContain(row.tokenHash);
    });
  });
});

describe("căutarea de produse pentru oferte", () => {
  it("după SKU sau titlu; fără produse digitale, arhivate sau ciorne; fără rezultate sub 2 caractere", async () => {
    await withOffers(async ({ h }) => {
      const named = async (title: string, over: Parameters<typeof h.product>[0] = {}) => {
        const created = await h.product(over);
        await h.tx.product.update({ where: { id: created.productId }, data: { title } });
        return created;
      };
      const active = await named("Pompă de căldură Zebra");
      await named("Pompă digitală Zebra", { type: "digital" });
      await named("Pompă arhivată Zebra", { status: "archived" });
      await named("Pompă ciornă Zebra", { status: "draft" });

      const byTitle = await searchOfferVariants(h.tx, "zebra");
      expect(byTitle.map((r) => r.variantId)).toEqual([active.variantId]);
      const bySku = await searchOfferVariants(h.tx, active.sku.toLowerCase());
      expect(bySku.map((r) => r.variantId)).toContain(active.variantId);
      expect(await searchOfferVariants(h.tx, "z")).toEqual([]);
      // un backslash la capăt nu strică interogarea
      expect(await searchOfferVariants(h.tx, "zebra\\")).toHaveLength(1);
      // rezultatul nu poartă prețuri de achiziție
      expect(JSON.stringify(byTitle).toLowerCase()).not.toContain("cost");
    });
  });
});
