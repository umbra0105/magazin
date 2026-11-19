import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { PaymentProvider } from "@ecom/shared";
import { codeOf, NOW, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
  type TestDeps,
} from "../test-utils/payment-fixtures";
import { StockService } from "../inventory/stock-service";
import {
  CardPaymentService,
  expireDueCardOrders,
  readCardPaymentView,
  sha256Hex,
  type CardSettings,
} from "./card-payment-service";
import { checkMoneyInvariant } from "./money-invariant";

/** Faza 10, plata cu cardul pe partea comenzii: inițiere, «reîncearcă plata», anulare la sfârșitul ferestrei, starea paginilor. */
const db = getDb();
afterAll(() => db.$disconnect());

const HOUR = 3_600_000;

function settings(over: Partial<CardSettings> = {}): CardSettings {
  return {
    reservationMinutes: 15,
    transferReservationWorkdays: 3,
    timeZone: "Europe/Bucharest",
    nonWorkingDates: [],
    cardRetryHours: 24,
    cardProvider: { code: "demo", mode: "demo" },
    ...over,
  };
}

function service(
  h: Harness,
  deps: TestDeps,
  over: { settings?: Partial<CardSettings>; failProvider?: boolean; noProvider?: boolean } = {},
) {
  const calls = { create: 0 };
  const base = deps.provider;
  const wrapped: PaymentProvider = {
    code: base.code,
    mode: base.mode,
    createPayment: async (input) => {
      calls.create += 1;
      if (over.failProvider) throw new Error("procesator picat");
      return base.createPayment(input);
    },
    verifyWebhook: (request) => base.verifyWebhook(request),
    capture: (ref, amount) => base.capture(ref, amount),
    refund: (request) => base.refund(request),
    getStatus: (ref) => base.getStatus(ref),
    testConnection: () => base.testConnection(),
  };
  return {
    calls,
    svc: new CardPaymentService({
      db: h.tx,
      getProvider: async () => (over.noProvider ? null : wrapped),
      readSettings: async () => settings(over.settings),
      now: () => deps.clock.now,
      returnUrl: (id) => `https://magazin.test/comanda/plata/${id}`,
      notifyUrl: (provider) => `https://magazin.test/api/webhooks/payments/${provider}`,
    }),
  };
}

const stockOf = (h: Harness, variantId: string) =>
  h.tx.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
  });

describe("inițierea plății", () => {
  it("trimite clientul la procesator, salvează referința și scrie un eveniment", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc, calls } = service(h, deps);
      const result = await svc.initiate(paymentId);
      expect(result).toEqual({
        kind: "redirect",
        redirect: { url: `https://magazin.test/plata-demo/${paymentId}`, method: "GET" },
      });
      expect(calls.create).toBe(1);
      const order = await orderOf(h.tx, orderId);
      expect(order.payments[0]?.providerRef).toBe(`demo-${paymentId}`);
      expect(order.events.map((e) => e.type)).toContain("payment.initiated");
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
    });
  });

  it("nu inițiază de două ori aceeași tentativă", async () => {
    await cardHarness(async (h) => {
      const { paymentId } = await placeCardOrder(h);
      const { svc, calls } = service(h, processorDeps(h));
      await svc.initiate(paymentId);
      expect(await svc.initiate(paymentId)).toEqual({ kind: "failed", reason: "not_pending" });
      expect(calls.create).toBe(1);
    });
  });

  it("furnizor picat: comanda NU se pierde, tentativa eșuează, stocul se eliberează, plata se poate reîncerca", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h);
      const { svc } = service(h, processorDeps(h), { failProvider: true });
      expect(await svc.initiate(paymentId)).toEqual({ kind: "failed", reason: "provider_error" });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
      expect(order.payments[0]).toMatchObject({ status: "failed", failureCode: "provider_error" });
      expect(order.events.map((e) => e.type)).toContain("payment.initiation_failed");
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      const view = await svc.stateOfOrder(orderId);
      expect(view).toMatchObject({ state: "failed", canRetry: true });
      // reîncercarea merge
      const { token } = await svc.issueRetryToken(orderId);
      const retry = await svc.startRetry(token);
      expect(retry.paymentId).not.toBe(paymentId);
    });
  });

  it("furnizor neconfigurat: eșec «unavailable», comanda rămâne în așteptare", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId } = await placeCardOrder(h);
      const { svc } = service(h, processorDeps(h), { noProvider: true });
      expect(await svc.initiate(paymentId)).toEqual({ kind: "failed", reason: "unavailable" });
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
    });
  });
});

describe("jetonul «reîncearcă plata»", () => {
  it("se stochează doar amprenta, nu jetonul; un jeton nou îl invalidează pe cel vechi", async () => {
    await cardHarness(async (h) => {
      const { orderId } = await placeCardOrder(h);
      const { svc } = service(h, processorDeps(h));
      const first = await svc.issueRetryToken(orderId);
      const rows = await h.tx.paymentRetryToken.findMany({ where: { orderId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).toBe(sha256Hex(first.token));
      expect(JSON.stringify(rows)).not.toContain(first.token);
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await svc.resolveRetryToken(first.token)).toEqual({ orderId });
      const second = await svc.issueRetryToken(orderId);
      expect(second.token).not.toBe(first.token);
      expect(await svc.resolveRetryToken(first.token)).toBeNull();
      expect(await svc.resolveRetryToken(second.token)).toEqual({ orderId });
      expect(second.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    });
  });

  it("jetoane necunoscute, malformate, ghicite sau cu ID de comandă nu dau acces (IDOR)", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId } = await placeCardOrder(h);
      const { svc } = service(h, processorDeps(h));
      await svc.issueRetryToken(orderId);
      for (const guess of [
        "",
        "x",
        orderId,
        paymentId,
        "A".repeat(43),
        "../../etc",
        " ".repeat(40),
      ]) {
        expect(await svc.resolveRetryToken(guess), guess).toBeNull();
      }
      expect(await codeOf(svc.startRetry(orderId))).toBe("PAYMENT_RETRY_UNAVAILABLE");
    });
  });

  it("nu se emite pentru comenzi cu ramburs, plătite, anulate sau după fereastră", async () => {
    await cardHarness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const cod = await h.checkout.place(owner, await h.input(owner));
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      expect(await codeOf(svc.issueRetryToken(cod.orderId))).toBe("PAYMENT_RETRY_UNAVAILABLE");

      const paid = await placeCardOrder(h);
      await deliver(deps, paidEvent(paid.paymentId, paid.amountMinor));
      expect(await codeOf(svc.issueRetryToken(paid.orderId))).toBe("PAYMENT_RETRY_UNAVAILABLE");

      const late = await placeCardOrder(h);
      deps.clock.now = new Date(NOW.getTime() + 25 * HOUR);
      expect(await codeOf(svc.issueRetryToken(late.orderId))).toBe("PAYMENT_RETRY_EXPIRED");
    });
  });

  it("jetonul expirat nu mai deschide nimic", async () => {
    await cardHarness(async (h) => {
      const { orderId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      const { token } = await svc.issueRetryToken(orderId);
      deps.clock.now = new Date(NOW.getTime() + 24 * HOUR + 1_000);
      expect(await svc.resolveRetryToken(token)).toBeNull();
      expect(await codeOf(svc.startRetry(token))).toBe("PAYMENT_RETRY_UNAVAILABLE");
    });
  });

  it("după plată jetonul nu mai poate fi folosit", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      const { token } = await svc.issueRetryToken(orderId);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      expect(await svc.resolveRetryToken(token)).toBeNull();
      expect(await codeOf(svc.startRetry(token))).toBe("PAYMENT_RETRY_UNAVAILABLE");
    });
  });
});

describe("reîncercarea: re-validează stocul și rezervă din nou doar dacă există", () => {
  async function failFirstAttempt(h: Harness, deps: TestDeps, paymentId: string) {
    await deliver(deps, { ...paidEvent(paymentId, 0), outcome: "failed", amountMinor: null });
  }

  it("creează tentativa 2, rezervă din nou, anulează tentativele în așteptare, actualizează expirarea rezervării", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      await failFirstAttempt(h, deps, paymentId);
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      deps.clock.now = new Date(NOW.getTime() + 10 * 60_000);
      const { token } = await svc.issueRetryToken(orderId);
      const retry = await svc.startRetry(token);
      const order = await orderOf(h.tx, orderId);
      expect(order.payments.map((p) => [p.attemptNo, p.status])).toEqual([
        [1, "failed"],
        [2, "pending"],
      ]);
      expect(order.payments[1]).toMatchObject({
        id: retry.paymentId,
        amountMinor: order.totalMinor,
      });
      expect((await stockOf(h, variantId)).reserved).toBe(q("1"));
      expect(order.reservationExpiresAt).toEqual(new Date(deps.clock.now.getTime() + 15 * 60_000));
      expect(order.events.map((e) => e.type)).toContain("payment.retry_started");
    });
  });

  it("fără stoc: mesaj clar (PAYMENT_RETRY_NO_STOCK), nicio tentativă nouă, nicio supravânzare", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h, { physical: "1" });
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      await failFirstAttempt(h, deps, paymentId);
      // altcineva cumpără ultima bucată
      const cod = await h.fill([{ variantId }]);
      await h.checkout.place(cod, await h.input(cod));
      const { token } = await svc.issueRetryToken(orderId);
      expect(await codeOf(svc.startRetry(token))).toBe("PAYMENT_RETRY_NO_STOCK");
      const order = await orderOf(h.tx, orderId);
      expect(order.payments).toHaveLength(1);
      expect(order.status).toBe("pending");
      const stock = await stockOf(h, variantId);
      expect(stock.committed).toBe(q("1"));
      expect(stock.reserved).toBe(0n);
    });
  });

  it("se poate reîncerca de mai multe ori până la plată", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      await failFirstAttempt(h, deps, paymentId);
      const { token } = await svc.issueRetryToken(orderId);
      const second = await svc.startRetry(token);
      await failFirstAttempt(h, deps, second.paymentId);
      const third = await svc.startRetry(token);
      expect((await orderOf(h.tx, orderId)).payments.map((p) => p.attemptNo)).toEqual([1, 2, 3]);
      await deliver(deps, paidEvent(third.paymentId, amountMinor));
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        status: "confirmed",
        paymentStatus: "paid",
      });
      expect(await checkMoneyInvariant(h.tx, third.paymentId)).toBe("confirmed");
    });
  });

  it("tentativa veche plătită târziu, după ce s-a început alta: comanda se confirmă pe ea, cea nouă se anulează", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      deps.clock.now = new Date(NOW.getTime() + 20 * 60_000);
      await new StockService({ db: h.tx, now: () => deps.clock.now }).expireDue();
      const { token } = await svc.issueRetryToken(orderId);
      const retry = await svc.startRetry(token);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.payments.map((p) => [p.attemptNo, p.status])).toEqual([
        [1, "paid"],
        [2, "cancelled"],
      ]);
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      // și dacă a doua tentativă e plătită totuși, banii se returnează (plată dublă), fără alt efect asupra comenzii
      await deliver(deps, paidEvent(retry.paymentId, amountMinor));
      const refunds = await h.tx.refund.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ paymentId: retry.paymentId, status: "confirmed" });
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        status: "confirmed",
        paymentStatus: "paid",
      });
      expect(await h.tx.stockCommitment.count({ where: { orderId } })).toBe(1);
      expect(await checkMoneyInvariant(h.tx, retry.paymentId)).toBe("refunded");
    });
  });
});

describe("anularea automată după fereastra de reîncercare", () => {
  it("anulează comanda, eliberează stocul, anulează tentativele în așteptare și invalidează jetoanele", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { svc } = service(h, deps);
      const { token } = await svc.issueRetryToken(orderId);
      const after = new Date(NOW.getTime() + 25 * HOUR);
      const result = await expireDueCardOrders(h.tx, { now: after });
      expect(result).toMatchObject({ cancelled: 1, failed: 0 });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({
        status: "cancelled",
        paymentStatus: "cancelled",
        fulfillmentStatus: "cancelled",
      });
      expect(order.payments[0]?.status).toBe("cancelled");
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      expect(order.events.map((e) => e.type)).toContain("order.auto_cancelled");
      deps.clock.now = after;
      expect(await svc.resolveRetryToken(token)).toBeNull();
      // idempotent
      expect(await expireDueCardOrders(h.tx, { now: after })).toMatchObject({ cancelled: 0 });
      expect(paymentId).toBeTruthy();
    });
  });

  it("nu atinge comenzi din fereastră, plătite, cu ramburs sau cu transfer", async () => {
    await cardHarness(async (h) => {
      const inWindow = await placeCardOrder(h);
      const paid = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(paid.paymentId, paid.amountMinor));
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const transfer = await h.checkout.place(
        owner,
        await h.input(owner, { paymentMethod: "bank_transfer" }),
      );
      const before = new Date(NOW.getTime() + 23 * HOUR);
      expect(await expireDueCardOrders(h.tx, { now: before })).toMatchObject({ cancelled: 0 });
      const after = new Date(NOW.getTime() + 30 * HOUR);
      expect(await expireDueCardOrders(h.tx, { now: after })).toMatchObject({ cancelled: 1 });
      expect((await orderOf(h.tx, inWindow.orderId)).status).toBe("cancelled");
      expect((await orderOf(h.tx, paid.orderId)).status).toBe("confirmed");
      expect((await orderOf(h.tx, transfer.orderId)).status).toBe("pending");
    });
  });

  it("nu anulează o comandă a cărei plată cere atenție (decide adminul) sau cu o tentativă începută recent", async () => {
    await cardHarness(async (h) => {
      const mismatch = await placeCardOrder(h);
      const recent = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(mismatch.paymentId, mismatch.amountMinor - 1));
      const after = new Date(NOW.getTime() + 24 * HOUR + 5 * 60_000);
      // tentativa `recent` a fost creată la NOW; simulăm una creată chiar înainte de termen
      await h.tx.payment.update({
        where: { id: recent.paymentId },
        data: { createdAt: new Date(after.getTime() - 10 * 60_000) },
      });
      const result = await expireDueCardOrders(h.tx, { now: after });
      expect(result.cancelled).toBe(0);
      expect((await orderOf(h.tx, mismatch.orderId)).status).toBe("pending");
      expect((await orderOf(h.tx, recent.orderId)).status).toBe("pending");
      // după perioada de grație, comanda fără probleme se anulează; cea cu atenție rămâne
      const later = new Date(after.getTime() + 40 * 60_000);
      expect(await expireDueCardOrders(h.tx, { now: later })).toMatchObject({ cancelled: 1 });
      expect((await orderOf(h.tx, recent.orderId)).status).toBe("cancelled");
      expect((await orderOf(h.tx, mismatch.orderId)).status).toBe("pending");
    });
  });
});

describe("starea citită de paginile de retur și de așteptare", () => {
  it("parcurge: se verifică → plătită; eșuată cu reîncercare; anulată; fără stoc; atenție", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const a = await placeCardOrder(h);
      // ceasul testului e fix (NOW); tentativa se creează „acum” în sensul lui
      await h.tx.payment.update({ where: { id: a.paymentId }, data: { createdAt: NOW } });
      expect(await readCardPaymentView(h.tx, a.orderId, NOW)).toMatchObject({
        state: "checking",
        canRetry: false,
        attemptNo: 1,
      });
      // după 2 minute fără răspuns se oferă și reîncercarea
      const waited = await readCardPaymentView(h.tx, a.orderId, new Date(NOW.getTime() + 130_000));
      expect(waited).toMatchObject({ state: "checking", canRetry: true });
      await deliver(deps, { ...paidEvent(a.paymentId, 0), outcome: "failed", amountMinor: null });
      expect(await readCardPaymentView(h.tx, a.orderId, NOW)).toMatchObject({
        state: "failed",
        canRetry: true,
      });
      expect(
        await readCardPaymentView(h.tx, a.orderId, new Date(NOW.getTime() + 25 * HOUR)),
      ).toMatchObject({
        state: "failed",
        canRetry: false,
      });

      const b = await placeCardOrder(h);
      await deliver(deps, paidEvent(b.paymentId, b.amountMinor));
      expect(await readCardPaymentView(h.tx, b.orderId, NOW)).toMatchObject({
        state: "paid",
        canRetry: false,
      });

      const c = await placeCardOrder(h);
      await deliver(deps, paidEvent(c.paymentId, c.amountMinor + 1));
      expect(await readCardPaymentView(h.tx, c.orderId, NOW)).toMatchObject({
        state: "attention",
        canRetry: false,
      });

      const d = await placeCardOrder(h);
      await expireDueCardOrders(h.tx, { now: new Date(NOW.getTime() + 30 * HOUR) });
      expect(await readCardPaymentView(h.tx, d.orderId, NOW)).toMatchObject({
        state: "cancelled",
        canRetry: false,
      });
    });
  });

  it("o comandă cu ramburs nu are stare de card (null)", async () => {
    await cardHarness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const cod = await h.checkout.place(owner, await h.input(owner));
      expect(await readCardPaymentView(h.tx, cod.orderId, NOW)).toBeNull();
      expect(await readCardPaymentView(h.tx, "nu-exista", NOW)).toBeNull();
    });
  });
});
