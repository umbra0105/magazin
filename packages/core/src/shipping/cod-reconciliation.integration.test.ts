import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import { listCodReconciliation, markCodCollected } from "./cod-reconciliation";
import { createManualShipment } from "./shipment-service";

/**
 * Reconcilierea rambursului pe Postgres real (tranzacție anulată): lista comenzilor expediate și nevirate, «Marchează încasat» cu
 * suma, referința și data; diferența de sumă cere decizie explicită și intră în «necesită atenție»; idempotent.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { actorLabel: "admin@test.ro", now: NOW };
const day = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function shipped(h: Harness, over: Record<string, unknown> = {}, productOver = {}) {
  const product = await h.product(productOver);
  const owner = await h.fill([{ variantId: product.variantId }]);
  const { orderId } = await h.checkout.place(owner, await h.input(owner, over));
  await createManualShipment(h.tx, orderId, {
    ...ACTOR,
    carrier: "Transportator",
    awb: `A-${orderId.slice(-6)}`,
  });
  return orderId;
}

const collect = (h: Harness, orderId: string, over: Record<string, unknown> = {}) =>
  markCodCollected(h.tx, orderId, {
    amountMinor: 0,
    reference: "OP 12345",
    collectedAt: day(-0),
    ...ACTOR,
    ...over,
  });

describe("lista de reconciliere", () => {
  it("conține doar comenzile cu ramburs expediate și neîncasate", async () => {
    await harness(async (h) => {
      const unshipped = await (async () => {
        const product = await h.product();
        const owner = await h.fill([{ variantId: product.variantId }]);
        return (await h.checkout.place(owner, await h.input(owner))).orderId;
      })();
      const a = await shipped(h);
      const bank = await (async () => {
        const product = await h.product();
        const owner = await h.fill([{ variantId: product.variantId }]);
        return (
          await h.checkout.place(owner, await h.input(owner, { paymentMethod: "bank_transfer" }))
        ).orderId;
      })();
      const before = await listCodReconciliation(h.tx, { limit: 500 });
      const ids = before.rows.map((r) => r.orderId);
      expect(ids).toContain(a);
      expect(ids).not.toContain(unshipped);
      expect(ids).not.toContain(bank);
      const row = before.rows.find((r) => r.orderId === a);
      const order = await orderOf(h.tx, a);
      expect(row).toMatchObject({ totalMinor: order.totalMinor, carrier: "Transportator" });
      await collect(h, a, { amountMinor: order.totalMinor });
      const after = await listCodReconciliation(h.tx, { limit: 500 });
      expect(after.rows.map((r) => r.orderId)).not.toContain(a);
      expect(after.total).toBe(before.total - 1);
    });
  });
});

describe("«Marchează încasat»", () => {
  it("suma exactă: plata devine încasată, cu suma, referința și data; evenimentul nu trimite email către client", async () => {
    await harness(async (h) => {
      const orderId = await shipped(h);
      const order = await orderOf(h.tx, orderId);
      const result = await collect(h, orderId, {
        amountMinor: order.totalMinor,
        collectedAt: NOW,
      });
      expect(result).toEqual({ alreadyPaid: false, differenceMinor: 0 });
      const after = await orderOf(h.tx, orderId);
      expect(after.paymentStatus).toBe("paid");
      const [payment] = after.payments;
      expect(payment).toMatchObject({
        status: "paid",
        capturedAmountMinor: order.totalMinor,
        attentionReason: null,
      });
      expect(payment?.capturedAt?.getTime()).toBe(NOW.getTime());
      expect(payment?.rawPayload).toMatchObject({ source: "admin", reference: "OP 12345" });
      const event = after.events.find((e) => e.type === "payment.cod_collected");
      expect(event?.actorLabel).toBe("admin@test.ro");
      expect(
        await h.tx.emailDispatch.count({ where: { orderId, template: "order.payment_received" } }),
      ).toBe(0);
    });
  });

  it("idempotent: a doua încasare nu schimbă nimic și nu scrie alt eveniment", async () => {
    await harness(async (h) => {
      const orderId = await shipped(h);
      const order = await orderOf(h.tx, orderId);
      await collect(h, orderId, { amountMinor: order.totalMinor });
      const again = await collect(h, orderId, { amountMinor: order.totalMinor + 500 });
      expect(again).toEqual({ alreadyPaid: true, differenceMinor: 0 });
      const after = await orderOf(h.tx, orderId);
      expect(after.events.filter((e) => e.type === "payment.cod_collected")).toHaveLength(1);
      expect(after.payments[0]?.capturedAmountMinor).toBe(order.totalMinor);
    });
  });

  it("sumă diferită: refuzată fără decizie explicită, cu cele două sume în detalii", async () => {
    await harness(async (h) => {
      const orderId = await shipped(h);
      const order = await orderOf(h.tx, orderId);
      const error = await collect(h, orderId, { amountMinor: order.totalMinor - 100 }).catch(
        (e) => e,
      );
      expect(error).toMatchObject({
        code: "ORDER_PAYMENT_AMOUNT_MISMATCH",
        details: {
          expectedMinor: order.totalMinor,
          receivedMinor: order.totalMinor - 100,
          differenceMinor: -100,
        },
      });
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("pending");
    });
  });

  it("sumă diferită cu decizie explicită: se înregistrează suma primită și plata intră în «necesită atenție»", async () => {
    await harness(async (h) => {
      const orderId = await shipped(h);
      const order = await orderOf(h.tx, orderId);
      const result = await collect(h, orderId, {
        amountMinor: order.totalMinor + 250,
        acceptDifference: true,
      });
      expect(result.differenceMinor).toBe(250);
      const [payment] = (await orderOf(h.tx, orderId)).payments;
      expect(payment).toMatchObject({
        status: "paid",
        capturedAmountMinor: order.totalMinor + 250,
        attentionReason: "amount_mismatch",
      });
    });
  });

  it("intrări invalide: referință scurtă, sumă nulă sau negativă, dată în viitor sau înaintea plasării", async () => {
    await harness(async (h) => {
      const orderId = await shipped(h);
      const order = await orderOf(h.tx, orderId);
      const ok = order.totalMinor;
      expect(await codeOf(collect(h, orderId, { amountMinor: ok, reference: "x" }))).toBe(
        "ORDER_PAYMENT_REFERENCE_INVALID",
      );
      for (const amountMinor of [0, -5, 12.5]) {
        expect(await codeOf(collect(h, orderId, { amountMinor }))).toBe(
          "ORDER_PAYMENT_AMOUNT_INVALID",
        );
      }
      expect(await codeOf(collect(h, orderId, { amountMinor: ok, collectedAt: day(1) }))).toBe(
        "ORDER_PAYMENT_DATE_INVALID",
      );
      expect(
        await codeOf(
          collect(h, orderId, {
            amountMinor: ok,
            collectedAt: new Date(order.placedAt.getTime() - 1000),
          }),
        ),
      ).toBe("ORDER_PAYMENT_DATE_INVALID");
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("pending");
    });
  });

  it("refuzată pentru o comandă neexpediată, una cu transfer bancar sau una inexistentă", async () => {
    await harness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const { orderId } = await h.checkout.place(owner, await h.input(owner));
      const order = await orderOf(h.tx, orderId);
      expect(await codeOf(collect(h, orderId, { amountMinor: order.totalMinor }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
      const owner2 = await h.fill([{ variantId: product.variantId }]);
      const bank = (
        await h.checkout.place(owner2, await h.input(owner2, { paymentMethod: "bank_transfer" }))
      ).orderId;
      // chiar și o comandă cu transfer bancar ajunsă (forțat) în tranzit nu se încasează ca ramburs
      await h.tx.order.update({
        where: { id: bank },
        data: { status: "confirmed", fulfillmentStatus: "in_transit" },
      });
      const bankOrder = await orderOf(h.tx, bank);
      expect(await codeOf(collect(h, bank, { amountMinor: bankOrder.totalMinor }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
      expect(await codeOf(collect(h, "nu-exista", { amountMinor: 1000 }))).toBe("ORDER_NOT_FOUND");
    });
  });

  it("comanda paletizată cu ramburs (cardul la livrare) se încasează la fel, fără metodă nouă", async () => {
    await harness(async (h) => {
      const orderId = await shipped(
        h,
        { shippingOfferCode: "pallet" },
        { shippingClass: "pallet" },
      );
      const order = await orderOf(h.tx, orderId);
      expect(order.paymentMethod).toBe("cod");
      await collect(h, orderId, { amountMinor: order.totalMinor });
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("paid");
    });
  });
});
