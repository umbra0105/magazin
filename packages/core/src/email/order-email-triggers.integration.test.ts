import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../test-utils/payment-fixtures";
import { addOrderEvent } from "../orders/order-service";
import { INTERNAL_RECIPIENTS_SETTING, scheduleOrderEmails } from "./order-email-triggers";

/**
 * Regulile «eveniment → email» (Faza 11), pe Postgres real, în tranzacție anulată: rândurile de trimis se scriu în aceeași
 * tranzacție cu evenimentul, o singură dată per eveniment (unicitate în bază), cu destinatarii și datele corecte.
 */
const db = getDb();
afterAll(() => db.$disconnect());

async function placed(h: Harness, over: { paymentMethod?: string; physical?: string } = {}) {
  const product = await h.product({ physical: over.physical ?? "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  const result = await h.checkout.place(
    owner,
    await h.input(owner, over.paymentMethod ? { paymentMethod: over.paymentMethod } : {}),
  );
  return { ...result, variantId: product.variantId };
}

const dispatches = (h: Harness, orderId: string) =>
  h.tx.emailDispatch.findMany({
    where: { orderId },
    orderBy: [{ template: "asc" }, { recipient: "asc" }],
  });

const setRecipients = (h: Harness, emails: string[]) =>
  h.tx.setting.upsert({
    where: { key: INTERNAL_RECIPIENTS_SETTING },
    create: { key: INTERNAL_RECIPIENTS_SETTING, group: "email", value: emails },
    update: { value: emails },
  });

describe("plasarea comenzii", () => {
  it("ramburs: o confirmare către client, cu eveniment, șablon și destinatar corecte; fără proformă și fără notificări interne", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const order = await h.tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { events: { where: { type: "order.placed" } } },
      });
      const rows = await dispatches(h, orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        template: "order.confirmation",
        recipient: order.email.toLowerCase(),
        audience: "customer",
        status: "queued",
        eventKey: `event:${order.events[0]?.id}`,
      });
    });
  });

  it("transfer bancar: confirmare ȘI proformă; ramburs și card nu primesc proformă", async () => {
    await harness(async (h) => {
      const transfer = await placed(h, { paymentMethod: "bank_transfer" });
      expect((await dispatches(h, transfer.orderId)).map((r) => r.template)).toEqual([
        "order.confirmation",
        "order.proforma",
      ]);
    });
    await cardHarness(async (h) => {
      const { orderId } = await placeCardOrder(h);
      expect((await dispatches(h, orderId)).map((r) => r.template)).toEqual(["order.confirmation"]);
    });
  });

  it("notificare internă: către fiecare destinatar din setare (adrese valide, fără dubluri); fără setare, nimic", async () => {
    await harness(async (h) => {
      await setRecipients(h, [
        "Echipa@Exemplu.ro",
        "echipa@exemplu.ro",
        "nu-e-adresa",
        "alt@exemplu.ro",
      ]);
      const { orderId } = await placed(h);
      const internal = (await dispatches(h, orderId)).filter((r) => r.audience === "internal");
      expect(internal.map((r) => [r.template, r.recipient])).toEqual([
        ["internal.order_new", "alt@exemplu.ro"],
        ["internal.order_new", "echipa@exemplu.ro"],
      ]);
    });
  });

  it("stoc epuizat: notificare internă doar pentru variantele rămase fără stoc disponibil", async () => {
    await harness(async (h) => {
      await setRecipients(h, ["echipa@exemplu.ro"]);
      const last = await placed(h, { physical: "1" });
      const out = (await dispatches(h, last.orderId)).filter(
        (r) => r.template === "internal.stock_out",
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.data).toMatchObject({ variantId: last.variantId });
      const plenty = await placed(h, { physical: "100" });
      expect(
        (await dispatches(h, plenty.orderId)).filter((r) => r.template === "internal.stock_out"),
      ).toHaveLength(0);
    });
  });

  it("fără destinatari interni setați, nu apare nicio notificare internă (nici stoc epuizat)", async () => {
    await harness(async (h) => {
      const last = await placed(h, { physical: "1" });
      expect((await dispatches(h, last.orderId)).filter((r) => r.audience === "internal")).toEqual(
        [],
      );
    });
  });

  it("comanda de pe un canal extern (externalId) nu primește emailuri către client", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await h.tx.emailDispatch.deleteMany({ where: { orderId } });
      await h.tx.order.update({ where: { id: orderId }, data: { externalId: "emag-1" } });
      await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "x" });
      expect(await dispatches(h, orderId)).toEqual([]);
    });
  });
});

describe("o singură dată per eveniment", () => {
  it("același eveniment programat de două ori (reprocesare) dă un singur rând pe șablon", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, { paymentMethod: "bank_transfer" });
      const event = await h.tx.orderEvent.findFirstOrThrow({
        where: { orderId, type: "order.placed" },
      });
      const before = await dispatches(h, orderId);
      await scheduleOrderEmails(h.tx, orderId, { id: event.id, type: event.type });
      await scheduleOrderEmails(h.tx, orderId, { id: event.id, type: event.type });
      expect(await dispatches(h, orderId)).toHaveLength(before.length);
      expect(before).toHaveLength(2);
    });
  });

  it("un eveniment NOU de același tip (altă acțiune) dă un email nou: nu se pierd emailurile legitime", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await addOrderEvent(h.tx, orderId, { type: "order.processing", message: "a" });
      await addOrderEvent(h.tx, orderId, { type: "order.processing", message: "b" });
      expect(
        (await dispatches(h, orderId)).filter((r) => r.template === "order.processing"),
      ).toHaveLength(2);
    });
  });
});

describe("evenimentele plăților", () => {
  it("plată confirmată: «plată primită», o singură dată chiar dacă notificarea sosește de două ori", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const event = paidEvent(paymentId, amountMinor);
      await deliver(deps, event);
      await deliver(deps, event, { key: "alta" });
      await deliver(deps, paidEvent(paymentId, amountMinor));
      const rows = (await dispatches(h, orderId)).filter(
        (r) => r.template === "order.payment_received",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.audience).toBe("customer");
    });
  });

  it("plată eșuată: «plată eșuată» către client", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      await deliver(deps, paidEvent(paymentId, amountMinor, { outcome: "failed" }));
      expect((await dispatches(h, orderId)).map((r) => r.template)).toContain(
        "order.payment_failed",
      );
    });
  });

  it("anularea automată: «comandă anulată» cu motivul «auto», fără date personale în `data`", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await addOrderEvent(h.tx, orderId, {
        type: "order.auto_cancelled",
        message: "expirat",
        data: { reservationExpiresAt: NOW.toISOString() },
      });
      const row = (await dispatches(h, orderId)).find((r) => r.template === "order.cancelled");
      expect(row?.data).toEqual({ eventType: "order.auto_cancelled", reason: "auto", paid: false });
    });
  });

  it("anulare de admin a unei comenzi plătite: `paid: true` în date (nota «rambursarea e anunțată separat»)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      await addOrderEvent(h.tx, orderId, {
        type: "order.cancelled",
        message: "anulată",
        data: { reason: "Produs indisponibil" },
        actorLabel: "operator@exemplu.ro",
      });
      const row = (await dispatches(h, orderId)).find((r) => r.template === "order.cancelled");
      expect(row?.data).toEqual({
        eventType: "order.cancelled",
        reason: "Produs indisponibil",
        paid: true,
      });
    });
  });

  it("rambursare confirmată: un email pe rambursare, cu suma; STOCK_RESERVATION_LOST: emailul lui", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await addOrderEvent(h.tx, orderId, {
        type: "payment.refunded",
        message: "r1",
        data: { refundId: "r1", amountMinor: 1_000 },
      });
      await addOrderEvent(h.tx, orderId, {
        type: "payment.refunded",
        message: "r2",
        data: { refundId: "r2", amountMinor: 2_500 },
      });
      await addOrderEvent(h.tx, orderId, { type: "payment.stock_lost", message: "stoc" });
      const rows = await dispatches(h, orderId);
      const refunded = rows.filter((r) => r.template === "order.refunded");
      expect(refunded.map((r) => (r.data as { amountMinor: number }).amountMinor).sort()).toEqual([
        1_000, 2_500,
      ]);
      expect(rows.map((r) => r.template)).toContain("order.stock_lost");
    });
  });

  it("expediată: AWB și curier din evenimentul Fazei 12 ajung în date; evenimentele fără regulă nu scriu nimic", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await addOrderEvent(h.tx, orderId, {
        type: "order.shipped",
        message: "expediată",
        data: { awb: "123456", carrier: "Curier X", token: "SECRET" },
      });
      await addOrderEvent(h.tx, orderId, { type: "note.added", message: "n" });
      await addOrderEvent(h.tx, orderId, { type: "order.supplier_marked", message: "f" });
      const rows = await dispatches(h, orderId);
      const shipped = rows.find((r) => r.template === "order.shipped");
      expect(shipped?.data).toEqual({
        eventType: "order.shipped",
        awb: "123456",
        carrier: "Curier X",
      });
      expect(JSON.stringify(rows)).not.toContain("SECRET");
      expect(rows.map((r) => r.template).sort()).toEqual(["order.confirmation", "order.shipped"]);
    });
  });
});

describe("cererea de instalare", () => {
  it("o comandă cu cerere de instalare notifică echipa (cu observațiile în date nu, ci în comandă); fără cerere, nu", async () => {
    await harness(async (h) => {
      await setRecipients(h, ["echipa@exemplu.ro"]);
      const plain = await placed(h);
      expect(
        (await dispatches(h, plain.orderId)).filter(
          (r) => r.template === "internal.installation_request",
        ),
      ).toEqual([]);
      const product = await h.product({ physical: "100" });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
      const wants = await h.checkout.place(
        owner,
        await h.input(owner, {
          installation: { requested: true, note: "Piscină 8x4, acces camion" },
        }),
      );
      const rows = (await dispatches(h, wants.orderId)).filter(
        (r) => r.template === "internal.installation_request",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ recipient: "echipa@exemplu.ro", audience: "internal" });
      expect(JSON.stringify(rows[0]?.data)).not.toContain("camion");
    });
  });
});
