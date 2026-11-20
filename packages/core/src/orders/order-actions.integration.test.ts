import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { checkMoneyInvariant } from "../payments/money-invariant";
import { requestOrderRefund } from "../payments/order-refund";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../test-utils/payment-fixtures";
import { cancelOrder, needsRefund, startProcessing } from "./order-actions";

/**
 * «Anulează» și «Începe pregătirea» din admin (Faza 11), pe Postgres real, în tranzacție anulată. Anularea unei comenzi plătite NU
 * rambursează automat: cere decizie explicită, lasă plata «plătită» și o pune în «necesită atenție» până la rambursare
 * (invariantul «niciun ban fără stare»).
 */
const db = getDb();
afterAll(() => db.$disconnect());

const WHO = { actorLabel: "operator@exemplu.ro", now: NOW };

async function placed(h: Harness, paymentMethod?: string, physical = "100") {
  const product = await h.product({ physical });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  const result = await h.checkout.place(
    owner,
    await h.input(owner, paymentMethod ? { paymentMethod } : {}),
  );
  return { ...result, variantId: product.variantId };
}

const stockOf = (h: Harness, variantId: string) =>
  h.tx.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
  });

describe("anularea", () => {
  it("transfer bancar în așteptare: comanda, plata și livrarea devin «anulate», rezervarea se eliberează, emailul de anulare e în coadă", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await placed(h, "bank_transfer");
      expect((await stockOf(h, variantId)).reserved).toBe(q("1"));
      const result = await cancelOrder(h.tx, orderId, { ...WHO, reason: "Clientul a renunțat" });
      expect(result).toEqual({ alreadyCancelled: false, needsRefund: false });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({
        status: "cancelled",
        paymentStatus: "cancelled",
        fulfillmentStatus: "cancelled",
      });
      expect(order.cancelledAt).toEqual(NOW);
      expect(order.payments[0]?.status).toBe("cancelled");
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      const event = order.events.find((e) => e.type === "order.cancelled");
      expect(event).toMatchObject({ actorLabel: "operator@exemplu.ro" });
      expect(event?.data).toEqual({ reason: "Clientul a renunțat", paid: false });
      const email = await h.tx.emailDispatch.findFirst({
        where: { orderId, template: "order.cancelled" },
      });
      expect(email?.data).toEqual({
        eventType: "order.cancelled",
        reason: "Clientul a renunțat",
        paid: false,
      });
    });
  });

  it("ramburs confirmat: angajarea de stoc se eliberează și disponibilul revine", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await placed(h, undefined, "5");
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      await cancelOrder(h.tx, orderId, { ...WHO, reason: "Stoc greșit" });
      const item = await stockOf(h, variantId);
      expect(item.committed).toBe(0n);
      expect(await h.tx.stockCommitment.count({ where: { orderId, status: "open" } })).toBe(0);
      expect((await orderOf(h.tx, orderId)).status).toBe("cancelled");
    });
  });

  it("a doua anulare e idempotentă: nu schimbă nimic și nu scrie alt eveniment sau alt email", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await cancelOrder(h.tx, orderId, { ...WHO, reason: "Motiv unu" });
      const events = await h.tx.orderEvent.count({ where: { orderId } });
      const emails = await h.tx.emailDispatch.count({ where: { orderId } });
      const again = await cancelOrder(h.tx, orderId, { ...WHO, reason: "Motiv doi" });
      expect(again.alreadyCancelled).toBe(true);
      expect(await h.tx.orderEvent.count({ where: { orderId } })).toBe(events);
      expect(await h.tx.emailDispatch.count({ where: { orderId } })).toBe(emails);
    });
  });

  it("motivul e obligatoriu și limitat (limitele exacte trec)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      for (const reason of ["", "  ", "ab", "x".repeat(301)]) {
        expect(await codeOf(cancelOrder(h.tx, orderId, { ...WHO, reason }))).toBe(
          "ORDER_CANCEL_INVALID",
        );
      }
      expect((await orderOf(h.tx, orderId)).status).toBe("confirmed");
      await cancelOrder(h.tx, orderId, { ...WHO, reason: "x".repeat(300) });
    });
  });

  it("comanda expediată sau în expediere nu se anulează", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await h.tx.$executeRawUnsafe(
        `UPDATE customer_order SET "fulfillmentStatus" = 'fulfilled' WHERE id = '${orderId}'`,
      );
      expect(await codeOf(cancelOrder(h.tx, orderId, { ...WHO, reason: "Prea târziu" }))).toBe(
        "ORDER_CANCEL_INVALID",
      );
      expect((await orderOf(h.tx, orderId)).status).toBe("confirmed");
    });
  });

  it("comandă inexistentă: ORDER_NOT_FOUND", async () => {
    await harness(async (h) => {
      expect(await codeOf(cancelOrder(h.tx, "nu-exista", { ...WHO, reason: "Motiv bun" }))).toBe(
        "ORDER_NOT_FOUND",
      );
    });
  });
});

describe("anularea unei comenzi PLĂTITE: nicio rambursare automată, niciun ban fără stare", () => {
  async function paidCard(h: Harness) {
    const deps = processorDeps(h);
    const placedOrder = await placeCardOrder(h);
    await deliver(deps, paidEvent(placedOrder.paymentId, placedOrder.amountMinor));
    return { ...placedOrder, deps };
  }

  it("fără decizie explicită: refuzată, nimic nu se modifică", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId } = await paidCard(h);
      expect(await codeOf(cancelOrder(h.tx, orderId, { ...WHO, reason: "Anulare" }))).toBe(
        "ORDER_CANCEL_PAID_NEEDS_DECISION",
      );
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("confirmed");
    });
  });

  it("cu decizie explicită: comanda se anulează, plata RĂMÂNE «plătită», fără rambursare, plata intră în «necesită atenție» și apare «de rambursat»", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId } = await paidCard(h);
      const result = await cancelOrder(h.tx, orderId, {
        ...WHO,
        reason: "Produs indisponibil",
        acknowledgePaid: true,
      });
      expect(result).toEqual({ alreadyCancelled: false, needsRefund: true });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({
        status: "cancelled",
        paymentStatus: "paid",
        fulfillmentStatus: "cancelled",
      });
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({
        status: "paid",
        refundCommittedMinor: 0,
        attentionReason: "order_cancelled_paid",
        attentionResolvedAt: null,
      });
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("attention");
      expect(await needsRefund(h.tx, orderId)).toBe(true);
      // angajarea de stoc a fost eliberată (marfa nu pleacă)
      expect(await h.tx.stockCommitment.count({ where: { orderId, status: "open" } })).toBe(0);
    });
  });

  it("rambursarea parțială nu rezolvă alerta (banii rămân); rambursarea totală o rezolvă și «de rambursat» dispare", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor, deps } = await paidCard(h);
      await cancelOrder(h.tx, orderId, {
        ...WHO,
        reason: "Produs indisponibil",
        acknowledgePaid: true,
      });
      const refundDeps = {
        db: h.tx,
        getProvider: async () => deps.provider,
        now: () => NOW,
        readLimitMinor: async () => 0,
      };
      await requestOrderRefund(refundDeps, {
        orderId,
        amountMinor: 1_000,
        reason: "Rambursare parțială",
        idempotencyKey: "order:p1",
        actorLabel: "m@exemplu.ro",
        actorUnlimited: true,
      });
      let payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.attentionReason).toBe("order_cancelled_paid");
      expect(payment.attentionResolvedAt).toBeNull();
      expect(await needsRefund(h.tx, orderId)).toBe(true);
      await requestOrderRefund(refundDeps, {
        orderId,
        amountMinor: amountMinor - 1_000,
        reason: "Restul",
        idempotencyKey: "order:p2",
        actorLabel: "m@exemplu.ro",
        actorUnlimited: true,
      });
      payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.attentionResolvedAt).not.toBeNull();
      expect(await needsRefund(h.tx, orderId)).toBe(false);
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("refunded");
    });
  });

  it("emailul de anulare spune că plata va fi tratată separat (paid: true în date)", async () => {
    await cardHarness(async (h) => {
      const { orderId } = await paidCard(h);
      await cancelOrder(h.tx, orderId, {
        ...WHO,
        reason: "Produs indisponibil",
        acknowledgePaid: true,
      });
      const email = await h.tx.emailDispatch.findFirstOrThrow({
        where: { orderId, template: "order.cancelled" },
      });
      expect(email.data).toMatchObject({ paid: true, reason: "Produs indisponibil" });
    });
  });
});

describe("începe pregătirea", () => {
  it("confirmed → processing, cu eveniment și email «în pregătire»; idempotent", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      expect(await startProcessing(h.tx, orderId, WHO)).toEqual({ alreadyProcessing: false });
      expect((await orderOf(h.tx, orderId)).status).toBe("processing");
      expect(
        await h.tx.emailDispatch.count({ where: { orderId, template: "order.processing" } }),
      ).toBe(1);
      expect(await startProcessing(h.tx, orderId, WHO)).toEqual({ alreadyProcessing: true });
      expect(
        await h.tx.emailDispatch.count({ where: { orderId, template: "order.processing" } }),
      ).toBe(1);
    });
  });

  it("o comandă în așteptare (neplătită) sau anulată nu trece în procesare", async () => {
    await harness(async (h) => {
      const pending = await placed(h, "bank_transfer");
      expect(await codeOf(startProcessing(h.tx, pending.orderId, WHO))).toBe(
        "ORDER_PROCESSING_INVALID",
      );
      const cancelled = await placed(h);
      await cancelOrder(h.tx, cancelled.orderId, { ...WHO, reason: "Motiv bun" });
      expect(await codeOf(startProcessing(h.tx, cancelled.orderId, WHO))).toBe(
        "ORDER_PROCESSING_INVALID",
      );
    });
  });
});
