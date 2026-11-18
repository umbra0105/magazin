import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "./checkout-fixtures";
import { confirmBankTransferPayment, expireDueTransferOrders } from "./order-payments";

/** Confirmarea transferului și anularea automată la expirare (Faza 9), pe Postgres real, în tranzacție anulată. */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 86_400_000;

async function transferOrder(h: Harness, over: { quantity?: string; physical?: string } = {}) {
  const product = await h.product({ physical: over.physical ?? "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q(over.quantity ?? "1") }]);
  const result = await h.checkout.place(
    owner,
    await h.input(owner, { paymentMethod: "bank_transfer" }),
  );
  return { ...result, variantId: product.variantId };
}

const stockOf = (h: Harness, variantId: string) =>
  h.tx.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
  });

describe("confirmarea plății prin transfer bancar", () => {
  it("rezervarea devine angajare, plata încasată, comanda confirmată (cu evenimente)", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await transferOrder(h);
      const before = await stockOf(h, variantId);
      expect(before.reserved).toBe(q("1"));
      expect(before.committed).toBe(0n);

      const result = await confirmBankTransferPayment(h.tx, orderId, { now: NOW });
      expect(result).toEqual({ alreadyPaid: false });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.confirmedAt).toEqual(NOW);
      expect(order.payments[0]).toMatchObject({ status: "paid" });
      expect(order.payments[0]?.capturedAt).toEqual(NOW);
      expect(order.stockReservations[0]?.status).toBe("confirmed");
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.events.map((e) => e.type)).toEqual([
        "order.placed",
        "stock.reserved",
        "payment.confirmed",
      ]);
      const after = await stockOf(h, variantId);
      expect(after.reserved).toBe(0n);
      expect(after.committed).toBe(q("1"));
    });
  });

  it("e idempotentă: a doua confirmare nu schimbă nimic", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await transferOrder(h);
      await confirmBankTransferPayment(h.tx, orderId, { now: NOW });
      expect(await confirmBankTransferPayment(h.tx, orderId, { now: NOW })).toEqual({
        alreadyPaid: true,
      });
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.confirmed" } })).toBe(
        1,
      );
    });
  });

  it("refuză o comandă cu ramburs și una inexistentă", async () => {
    await harness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const cod = await h.checkout.place(owner, await h.input(owner));
      expect(await codeOf(confirmBankTransferPayment(h.tx, cod.orderId, { now: NOW }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
      expect(await codeOf(confirmBankTransferPayment(h.tx, "nu-exista", { now: NOW }))).toBe(
        "ORDER_NOT_FOUND",
      );
    });
  });
});

describe("anularea automată la expirarea transferului", () => {
  it("după termen: comanda se anulează, rezervarea se eliberează, plata se anulează, cu evenimente", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await transferOrder(h);
      const order = await orderOf(h.tx, orderId);
      const after = new Date(order.reservationExpiresAt!.getTime() + 1_000);

      const result = await expireDueTransferOrders(h.tx, { now: after });
      expect(result).toMatchObject({ cancelled: 1, failed: 0, more: false });

      const cancelled = await orderOf(h.tx, orderId);
      expect(cancelled).toMatchObject({
        status: "cancelled",
        paymentStatus: "cancelled",
        fulfillmentStatus: "cancelled",
      });
      expect(cancelled.cancelledAt).toEqual(after);
      expect(cancelled.payments[0]?.status).toBe("cancelled");
      expect(cancelled.stockReservations[0]?.status).toMatch(/released|expired/);
      expect(cancelled.events.map((e) => e.type)).toEqual([
        "order.placed",
        "stock.reserved",
        "order.auto_cancelled",
        "stock.released",
      ]);
      const stock = await stockOf(h, variantId);
      expect(stock.reserved).toBe(0n);
      expect(stock.committed).toBe(0n);
      await h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });

  it("e idempotentă: a doua rulare nu mai găsește nimic", async () => {
    await harness(async (h) => {
      const { orderId } = await transferOrder(h);
      const end = (await orderOf(h.tx, orderId)).reservationExpiresAt!;
      const after = new Date(end.getTime() + 1);
      await expireDueTransferOrders(h.tx, { now: after });
      expect(await expireDueTransferOrders(h.tx, { now: after })).toMatchObject({ cancelled: 0 });
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.auto_cancelled" } }),
      ).toBe(1);
    });
  });

  it("înainte de termen (chiar la termen) comanda rămâne; un ban de timp după, se anulează", async () => {
    await harness(async (h) => {
      const { orderId } = await transferOrder(h);
      const end = (await orderOf(h.tx, orderId)).reservationExpiresAt!;
      expect(
        await expireDueTransferOrders(h.tx, { now: new Date(end.getTime() - 1) }),
      ).toMatchObject({ cancelled: 0 });
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
      // exact la termen: termenul e inclusiv (reservationExpiresAt <= now)
      expect(await expireDueTransferOrders(h.tx, { now: end })).toMatchObject({ cancelled: 1 });
    });
  });

  it("comenzile cu ramburs și cele deja plătite nu se anulează niciodată", async () => {
    await harness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const cod = await h.checkout.place(owner, await h.input(owner));
      const paid = await transferOrder(h);
      await confirmBankTransferPayment(h.tx, paid.orderId, { now: NOW });
      const far = new Date(NOW.getTime() + 365 * DAY);
      expect(await expireDueTransferOrders(h.tx, { now: far })).toMatchObject({ cancelled: 0 });
      expect((await orderOf(h.tx, cod.orderId)).status).toBe("confirmed");
      expect((await orderOf(h.tx, paid.orderId)).status).toBe("confirmed");
    });
  });

  it("o comandă anulată automat nu se mai poate confirma ca plătită", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await transferOrder(h);
      const end = (await orderOf(h.tx, orderId)).reservationExpiresAt!;
      await expireDueTransferOrders(h.tx, { now: new Date(end.getTime() + 1) });
      expect(await codeOf(confirmBankTransferPayment(h.tx, orderId, { now: NOW }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
      expect((await stockOf(h, variantId)).committed).toBe(0n);
    });
  });

  it("stocul eliberat se poate rezerva din nou de alt client (nu rămâne blocat)", async () => {
    await harness(async (h) => {
      const product = await h.product({ physical: "1" });
      const first = await h.fill([{ variantId: product.variantId }]);
      const placed = await h.checkout.place(
        first,
        await h.input(first, { paymentMethod: "bank_transfer" }),
      );
      const end = (await orderOf(h.tx, placed.orderId)).reservationExpiresAt!;
      const second = await h.fill([{ variantId: product.variantId }]).catch(() => null);
      // cât timp rezervarea ține, stocul de 1 e luat: al doilea client nu poate nici măcar adăuga în coș
      expect(
        second === null || (await h.cart.view(second)).lines.every((l) => l.issues.length > 0),
      ).toBe(true);
      await expireDueTransferOrders(h.tx, { now: new Date(end.getTime() + 1) });
      const third = await h.fill([{ variantId: product.variantId }]);
      const result = await h.checkout.place(third, await h.input(third));
      expect(result.replayed).toBe(false);
    });
  });

  it("un lot plin lasă restul pentru rularea următoare", async () => {
    await harness(async (h) => {
      const a = await transferOrder(h);
      const b = await transferOrder(h);
      const after = new Date(NOW.getTime() + 30 * DAY);
      const first = await expireDueTransferOrders(h.tx, { now: after, limit: 1 });
      expect(first).toMatchObject({ cancelled: 1, more: true });
      const second = await expireDueTransferOrders(h.tx, { now: after, limit: 1 });
      expect(second).toMatchObject({ cancelled: 1, more: false });
      expect((await orderOf(h.tx, a.orderId)).status).toBe("cancelled");
      expect((await orderOf(h.tx, b.orderId)).status).toBe("cancelled");
    });
  });
});
