import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { requestOrderRefund } from "../payments/order-refund";
import { NOW, codeOf, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../test-utils/payment-fixtures";
import { getAdminOrderDetail } from "./admin-order-read";
import {
  countOrderViews,
  listAdminOrders,
  ORDER_VIEWS,
  type OrderListQuery,
} from "./admin-order-list";
import { cancelOrder } from "./order-actions";
import {
  VIEWS_PER_USER,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  renameSavedView,
} from "./order-saved-views";
import { markAtSupplier } from "./order-supplier";

/**
 * Lista și detaliul comenzilor pentru admin (Faza 11), pe Postgres real, în tranzacție anulată: vederile implicite, căutarea,
 * filtrele, sortarea deterministă, contoarele (identice cu lista), drepturile de citire și vederile salvate pe utilizator.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ALL = { pii: true } as const;

async function place(h: Harness, paymentMethod?: string, over: Record<string, unknown> = {}) {
  const product = await h.product({ physical: "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  const result = await h.checkout.place(
    owner,
    await h.input(owner, { ...(paymentMethod ? { paymentMethod } : {}), ...over }),
  );
  const order = await h.tx.order.findUniqueOrThrow({ where: { id: result.orderId } });
  return { ...result, number: order.number, email: order.email };
}

/** Lista restrânsă la o comandă (după număr), ca să nu depindă de alte rânduri din bază. */
const only = (h: Harness, number: string, query: OrderListQuery = {}) =>
  listAdminOrders(h.tx, { ...query, q: number, pageSize: 100 }, ALL);

describe("vederile implicite", () => {
  it("fiecare comandă apare exact în vederile ei: «De procesat», «Plată în așteptare», «La furnizor», «Necesită atenție»", async () => {
    await cardHarness(async (h) => {
      const cod = await place(h);
      const transfer = await place(h, "bank_transfer");
      const supplierOrder = await place(h);
      await markAtSupplier(h.tx, supplierOrder.orderId, {
        supplierName: "F1",
        note: null,
        actorLabel: "o@e.ro",
        now: NOW,
      });
      const inView = async (order: { number: string }, view: OrderListQuery["view"]) =>
        (await only(h, order.number, { view })).total;

      expect(await inView(cod, "all")).toBe(1);
      expect(await inView(cod, "to_process")).toBe(1);
      expect(await inView(cod, "payment_pending")).toBe(0);
      expect(await inView(cod, "supplier")).toBe(0);
      expect(await inView(cod, "attention")).toBe(0);

      expect(await inView(transfer, "payment_pending")).toBe(1);
      expect(await inView(transfer, "to_process")).toBe(0);

      expect(await inView(supplierOrder, "supplier")).toBe(1);
      expect(await inView(supplierOrder, "to_process")).toBe(1);

      // card plătit, apoi anulat: banii rămân la noi => «Necesită atenție» până la rambursare
      const deps = processorDeps(h);
      const card = await placeCardOrder(h);
      await deliver(deps, paidEvent(card.paymentId, card.amountMinor));
      const cardOrder = await h.tx.order.findUniqueOrThrow({ where: { id: card.orderId } });
      expect(await inView(cardOrder, "attention")).toBe(0);
      await cancelOrder(h.tx, card.orderId, {
        reason: "Produs indisponibil",
        actorLabel: "o@e.ro",
        now: NOW,
        acknowledgePaid: true,
      });
      expect(await inView(cardOrder, "attention")).toBe(1);
      const row = (await only(h, cardOrder.number)).rows[0];
      expect(row).toMatchObject({ status: "cancelled", needsRefund: true, attention: true });
      expect(row?.attentionReason).toBe("order_cancelled_paid");
      // rambursat integral: iese din «Necesită atenție»
      await requestOrderRefund(
        {
          db: h.tx,
          getProvider: async () => deps.provider,
          now: () => NOW,
          readLimitMinor: async () => 0,
        },
        {
          orderId: card.orderId,
          amountMinor: card.amountMinor,
          reason: "Rambursare integrală",
          idempotencyKey: "order:list-1",
          actorLabel: "m@e.ro",
          actorUnlimited: true,
        },
      );
      expect(await inView(cardOrder, "attention")).toBe(0);
      expect((await only(h, cardOrder.number)).rows[0]?.needsRefund).toBe(false);
    });
  });

  it("CONTORUL din vedere e identic cu lista: pentru fiecare vedere, numărătoarea = totalul listei", async () => {
    await harness(async (h) => {
      await place(h);
      await place(h, "bank_transfer");
      const s = await place(h);
      await markAtSupplier(h.tx, s.orderId, {
        supplierName: null,
        note: null,
        actorLabel: "o@e.ro",
        now: NOW,
      });
      const counts = await countOrderViews(h.tx);
      for (const view of ORDER_VIEWS) {
        const list = await listAdminOrders(h.tx, { view, pageSize: 100 }, ALL);
        expect(counts[view], view).toBe(list.total);
      }
      expect(counts.to_process).toBeGreaterThanOrEqual(2);
      expect(counts.payment_pending).toBeGreaterThanOrEqual(1);
      expect(counts.supplier).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("căutarea", () => {
  it("după număr (întreg sau doar cifrele de la coadă), email, telefon, nume și CUI; fără rezultat pentru ce nu există", async () => {
    await harness(async (h) => {
      const a = await place(h, undefined, {
        company: { name: "Firma Test SRL", vatId: "RO1234567", tradeRegisterNo: "J1/1/2000" },
      }).catch(() => place(h));
      const found = async (text: string) =>
        (await listAdminOrders(h.tx, { q: text, pageSize: 100 }, ALL)).rows.map((r) => r.number);
      expect(await found(a.number)).toContain(a.number);
      expect(await found(a.number.toLowerCase())).toContain(a.number);
      expect(await found(a.number.replace(/\D/g, ""))).toContain(a.number);
      expect(await found(a.email.toUpperCase())).toContain(a.number);
      const order = await h.tx.order.findUniqueOrThrow({
        where: { id: a.orderId },
        include: { addresses: true },
      });
      expect(await found(order.phone)).toContain(a.number);
      expect(await found(order.addresses[0]?.fullName ?? "?")).toContain(a.number);
      expect(await found(`zzz-${randomUUID()}`)).toEqual([]);
    });
  });

  it("textul căutat nu schimbă interogarea (nu e SQL): apostrof, procent și underscore sunt litere obișnuite", async () => {
    await harness(async (h) => {
      await place(h);
      for (const text of ["'; DROP TABLE x;--", "%", "_", "\\"]) {
        const result = await listAdminOrders(h.tx, { q: text, pageSize: 100 }, ALL);
        expect(Array.isArray(result.rows)).toBe(true);
      }
      expect((await listAdminOrders(h.tx, { pageSize: 100 }, ALL)).total).toBeGreaterThan(0);
    });
  });
});

describe("filtrele", () => {
  it("stare, plată, fulfillment, metodă, livrare/ridicare, interval, sumă și marcaj de furnizor", async () => {
    await harness(async (h) => {
      const cod = await place(h);
      const transfer = await place(h, "bank_transfer");
      const pickup = await place(h, undefined, { shippingOfferCode: "pickup" });
      const mark = await place(h);
      await markAtSupplier(h.tx, mark.orderId, {
        supplierName: "F",
        note: null,
        actorLabel: "o@e.ro",
        now: NOW,
      });
      const numbers = async (query: OrderListQuery) =>
        (await listAdminOrders(h.tx, { ...query, pageSize: 100 }, ALL)).rows.map((r) => r.number);
      expect(await numbers({ status: ["pending"] })).toContain(transfer.number);
      expect(await numbers({ status: ["pending"] })).not.toContain(cod.number);
      expect(await numbers({ paymentMethod: ["bank_transfer"] })).toEqual([transfer.number]);
      expect(
        await numbers({ fulfillmentStatus: ["unfulfilled"], paymentStatus: ["pending"] }),
      ).toContain(transfer.number);
      expect(await numbers({ delivery: "pickup" })).toEqual([pickup.number]);
      expect(await numbers({ delivery: "courier" })).not.toContain(pickup.number);
      expect(await numbers({ supplier: true })).toEqual([mark.number]);
      const total = (await h.tx.order.findUniqueOrThrow({ where: { id: cod.orderId } })).totalMinor;
      expect(await numbers({ minTotalMinor: total, maxTotalMinor: total })).toContain(cod.number);
      expect(await numbers({ minTotalMinor: total + 1 })).not.toContain(cod.number);
      expect(await numbers({ maxTotalMinor: total - 1 })).not.toContain(cod.number);
      // intervalul: de la inclusiv, până la exclusiv
      expect(await numbers({ from: NOW, to: new Date(NOW.getTime() + 1) })).toContain(cod.number);
      expect(await numbers({ from: new Date(NOW.getTime() + 1) })).not.toContain(cod.number);
      expect(await numbers({ to: NOW })).not.toContain(cod.number);
    });
  });

  it("cererile de instalare: filtru pe stare, doar comenzile care au cerut", async () => {
    await harness(async (h) => {
      const plain = await place(h);
      const wants = await place(h, undefined, {
        installation: { requested: true, note: "Piscină 8x4" },
      });
      const row = (await only(h, wants.number)).rows[0];
      expect(row?.installationStatus).toBe("requested");
      expect((await only(h, plain.number)).rows[0]?.installationStatus).toBeNull();
      const requested = await listAdminOrders(
        h.tx,
        { installation: ["requested"], pageSize: 100 },
        ALL,
      );
      expect(requested.rows.map((r) => r.number)).toContain(wants.number);
      expect(requested.rows.map((r) => r.number)).not.toContain(plain.number);
    });
  });
});

describe("sortare, paginare, drepturi", () => {
  it("ordinea e deterministă: paginile nu se suprapun nici când toate comenzile au aceeași dată; sumă crescător/descrescător", async () => {
    await harness(async (h) => {
      for (let i = 0; i < 5; i++) await place(h);
      const seen = new Set<string>();
      let total = 0;
      for (let page = 1; page <= 20; page++) {
        const result = await listAdminOrders(h.tx, { pageSize: 10, page }, ALL);
        total = result.total;
        for (const row of result.rows) {
          expect(seen.has(row.id), row.number).toBe(false);
          seen.add(row.id);
        }
        if (result.rows.length === 0) break;
      }
      expect(seen.size).toBe(total);
      const asc = await listAdminOrders(h.tx, { sort: "number_asc", pageSize: 100 }, ALL);
      const desc = await listAdminOrders(h.tx, { sort: "number_desc", pageSize: 100 }, ALL);
      expect(asc.rows.map((r) => r.id)).toEqual(desc.rows.map((r) => r.id).reverse());
      const byTotal = await listAdminOrders(h.tx, { sort: "total_desc", pageSize: 100 }, ALL);
      const totals = byTotal.rows.map((r) => r.totalMinor);
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
    });
  });

  it("dimensiunea paginii necunoscută revine la 25; pagina < 1 devine 1", async () => {
    await harness(async (h) => {
      const result = await listAdminOrders(h.tx, { pageSize: 7, page: -3 }, ALL);
      expect(result.pageSize).toBe(25);
      expect(result.page).toBe(1);
    });
  });

  it("fără drept de date personale, lista nu conține nume sau email", async () => {
    await harness(async (h) => {
      const order = await place(h);
      const row = (await listAdminOrders(h.tx, { q: order.number }, { pii: false })).rows[0];
      expect(row?.customerName).toBeNull();
      expect(row?.email).toBeNull();
      expect(row?.number).toBe(order.number);
      const full = (await listAdminOrders(h.tx, { q: order.number }, ALL)).rows[0];
      expect(full?.email).toBe(order.email);
      expect(full?.customerName).toBeTruthy();
    });
  });
});

describe("detaliul comenzii: secțiuni după drept", () => {
  it("cu toate drepturile: linii, adrese, plăți, emailuri, cronologie; ridicarea arată adresa magazinului, nu a clientului", async () => {
    await cardHarness(async (h) => {
      const order = await place(h, undefined, { shippingOfferCode: "pickup" });
      const detail = await getAdminOrderDetail(h.tx, order.orderId, {
        pii: true,
        payments: true,
        emails: true,
      });
      expect(detail?.number).toBe(order.number);
      expect(detail?.lines).toHaveLength(1);
      expect(detail?.shipping).toMatchObject({ kind: "pickup", code: "pickup" });
      expect(detail?.shipping.pickupAddressText).toBe(
        "Strada Magazinului 7, 510000 Alba Iulia, Alba",
      );
      expect(detail?.addresses?.map((a) => a.kind)).toEqual(["billing", "shipping"]);
      expect(detail?.payments).toHaveLength(1);
      expect(detail?.emails?.[0]).toMatchObject({
        template: "order.confirmation",
        status: "queued",
      });
      expect(detail?.events.map((e) => e.type)).toContain("order.placed");
      expect(JSON.stringify(detail)).not.toContain("productSnapshot");
      expect(JSON.stringify(detail)).not.toContain("costPrice");
    });
  });

  it("fără date personale: nici contact, nici adrese, nici nota clientului; fără plăți și fără emailuri: secțiunile sunt nule, nu goale", async () => {
    await harness(async (h) => {
      const order = await place(h, undefined, { customerNote: "Sunați la poartă" });
      const detail = await getAdminOrderDetail(h.tx, order.orderId, {
        pii: false,
        payments: false,
        emails: false,
      });
      expect(detail?.contact).toBeNull();
      expect(detail?.addresses).toBeNull();
      expect(detail?.customerNote).toBeNull();
      expect(detail?.payments).toBeNull();
      expect(detail?.emails).toBeNull();
      expect(JSON.stringify(detail)).not.toContain(order.email);
      expect(JSON.stringify(detail)).not.toContain("Sunați la poartă");
      // dar cronologia, liniile și sumele rămân (cine vede comanda le vede)
      expect(detail?.lines).toHaveLength(1);
      expect(detail?.totals.totalMinor).toBeGreaterThan(0);
    });
  });

  it("comanda inexistentă: null; suma rambursabilă vine din plata încasată", async () => {
    await cardHarness(async (h) => {
      expect(
        await getAdminOrderDetail(h.tx, "nu-exista", { pii: true, payments: true, emails: true }),
      ).toBeNull();
      const deps = processorDeps(h);
      const card = await placeCardOrder(h);
      let detail = await getAdminOrderDetail(h.tx, card.orderId, {
        pii: true,
        payments: true,
        emails: true,
      });
      expect(detail?.refundable).toBeNull();
      await deliver(deps, paidEvent(card.paymentId, card.amountMinor));
      detail = await getAdminOrderDetail(h.tx, card.orderId, {
        pii: true,
        payments: true,
        emails: true,
      });
      expect(detail?.refundable).toEqual({
        paymentId: card.paymentId,
        remainingMinor: card.amountMinor,
      });
      expect(detail?.needsRefund).toBe(true);
    });
  });
});

describe("vederile salvate", () => {
  async function user(h: Harness, name: string) {
    return h.tx.user.create({
      data: { id: `u-${randomUUID()}`, name, email: `${name}-${randomUUID()}@exemplu.invalid` },
    });
  }

  it("creare, redenumire, ștergere; numele e unic per utilizator, dar poate repeta între utilizatori", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      const b = await user(h, "b");
      const view = await createSavedView(h.tx, a.id, {
        name: "  Doar  transfer ",
        query: "metoda=bank_transfer",
      });
      expect(view.name).toBe("Doar transfer");
      expect(await codeOf(createSavedView(h.tx, a.id, { name: "Doar transfer", query: "" }))).toBe(
        "ORDER_VIEW_DUPLICATE",
      );
      await createSavedView(h.tx, b.id, { name: "Doar transfer", query: "x=1" });
      await renameSavedView(h.tx, a.id, view.id, "Transfer bancar");
      expect((await listSavedViews(h.tx, a.id)).map((v) => v.name)).toEqual(["Transfer bancar"]);
      await deleteSavedView(h.tx, a.id, view.id);
      expect(await listSavedViews(h.tx, a.id)).toEqual([]);
      expect(await listSavedViews(h.tx, b.id)).toHaveLength(1);
    });
  });

  it("un utilizator NU poate redenumi sau șterge vederea altuia", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      const b = await user(h, "b");
      const view = await createSavedView(h.tx, a.id, { name: "A", query: "" });
      expect(await codeOf(renameSavedView(h.tx, b.id, view.id, "Furată"))).toBe(
        "ORDER_VIEW_NOT_FOUND",
      );
      expect(await codeOf(deleteSavedView(h.tx, b.id, view.id))).toBe("ORDER_VIEW_NOT_FOUND");
      expect((await listSavedViews(h.tx, a.id))[0]?.name).toBe("A");
      expect(await listSavedViews(h.tx, b.id)).toEqual([]);
    });
  });

  it("nume gol sau prea lung, filtre prea lungi și limita de vederi se refuză; limitele exacte trec", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      for (const name of ["", "   ", "x".repeat(41)]) {
        expect(await codeOf(createSavedView(h.tx, a.id, { name, query: "" }))).toBe(
          "ORDER_VIEW_INVALID",
        );
      }
      expect(
        await codeOf(createSavedView(h.tx, a.id, { name: "ok", query: "x".repeat(1001) })),
      ).toBe("ORDER_VIEW_INVALID");
      await createSavedView(h.tx, a.id, { name: "x".repeat(40), query: "y".repeat(1000) });
      for (let i = 1; i < VIEWS_PER_USER; i++)
        await createSavedView(h.tx, a.id, { name: `v${i}`, query: "" });
      expect(await codeOf(createSavedView(h.tx, a.id, { name: "una-prea-mult", query: "" }))).toBe(
        "ORDER_VIEW_LIMIT",
      );
    });
  });
});
