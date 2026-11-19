import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  demoRequest,
  paidEvent,
  placeCardOrder,
  processorDeps,
  SIGNING_KEY,
} from "../test-utils/payment-fixtures";
import { StockService } from "../inventory/stock-service";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { checkMoneyInvariant } from "./money-invariant";
import { ingestPaymentWebhook, processPaymentEvent, sweepPaymentEvents } from "./payment-processor";

/**
 * Faza 10, procesarea notificărilor de plată: pe Postgres real, în tranzacție anulată. Cazurile obligatorii: succes, eșec,
 * sumă diferită, monedă diferită, webhook duplicat, întârziat, pe comandă anulată, în ordine inversă, plată târzie cu stoc și
 * fără stoc (STOCK_RESERVATION_LOST), plus invariantul «niciun ban fără stare».
 */
const db = getDb();
afterAll(() => db.$disconnect());

const stockOf = (h: Harness, variantId: string) =>
  h.tx.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
  });

const eventTypes = async (h: Harness, orderId: string) =>
  (await orderOf(h.tx, orderId)).events.map((e) => e.type);

describe("succes", () => {
  it("confirmă comanda, angajează stocul o singură dată și păstrează doar ultimele 4 cifre", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      expect((await stockOf(h, variantId)).reserved).toBe(q("1"));
      const deps = processorDeps(h);
      const { ingest, processed } = await deliver(deps, paidEvent(paymentId, amountMinor));
      expect(ingest.outcome).toBe("accepted");
      expect(ingest.body).toBe("OK");
      expect(processed).toBe(true);

      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.payments[0]).toMatchObject({
        status: "paid",
        capturedAmountMinor: amountMinor,
        capturedCurrency: "RON",
        cardLast4: "4242",
      });
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.stockReservations[0]?.status).toBe("confirmed");
      const stock = await stockOf(h, variantId);
      expect(stock.reserved).toBe(0n);
      expect(stock.committed).toBe(q("1"));
      expect(await eventTypes(h, orderId)).toEqual([
        "order.placed",
        "stock.reserved",
        "payment.confirmed",
      ]);
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("confirmed");
    });
  });

  it("marchează furnizorul «verificat în sandbox» doar la plată în mod test cu semnătură validă", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      await h.tx.payment.update({
        where: { id: paymentId },
        data: { provider: "euplatesc", mode: "test" },
      });
      const deps = processorDeps(h);
      deps.getProvider = async () => deps.provider;
      await deliver(deps, paidEvent(paymentId, amountMinor), { providerCode: "euplatesc" });
      expect(deps.verified).toEqual(["euplatesc"]);
    });
  });

  it("o plată în mod LIVE nu marchează verificarea", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      await h.tx.payment.update({
        where: { id: paymentId },
        data: { provider: "netopia", mode: "live" },
      });
      const deps = processorDeps(h);
      deps.getProvider = async () => deps.provider;
      await deliver(deps, paidEvent(paymentId, amountMinor), { providerCode: "netopia" });
      expect(deps.verified).toEqual([]);
    });
  });

  it("o plată în mod test cu suma greșită NU marchează verificarea", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      await h.tx.payment.update({
        where: { id: paymentId },
        data: { provider: "euplatesc", mode: "test" },
      });
      const deps = processorDeps(h);
      deps.getProvider = async () => deps.provider;
      await deliver(deps, paidEvent(paymentId, amountMinor - 1), { providerCode: "euplatesc" });
      expect(deps.verified).toEqual([]);
    });
  });

  it("modul demo și modul live NU marchează verificarea", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      expect(deps.verified).toEqual([]);
    });
  });
});

describe("eșec și anulare de client", () => {
  it("plata devine «failed», rezervarea se eliberează, comanda rămâne în așteptare (se poate reîncerca)", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, { ...paidEvent(paymentId, 0), outcome: "failed", amountMinor: null });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
      expect(order.payments[0]?.status).toBe("failed");
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      expect(await eventTypes(h, orderId)).toContain("payment.failed");
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("unpaid");
    });
  });

  it("starea intermediară (3DS) nu e eșec și nu schimbă nimic", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, { ...paidEvent(paymentId, 0), outcome: "pending", amountMinor: null });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
      expect(order.payments[0]?.status).toBe("pending");
      expect((await stockOf(h, variantId)).reserved).toBe(q("1"));
    });
  });
});

describe("sumă și monedă diferite: NU se confirmă, NU se rambursează automat", () => {
  const cases: Array<[string, (amount: number) => Record<string, unknown>, string]> = [
    ["sumă mai mică", (a) => ({ amountMinor: a - 1 }), "amount_mismatch"],
    ["sumă mai mare", (a) => ({ amountMinor: a + 1 }), "amount_mismatch"],
    ["sumă lipsă", () => ({ amountMinor: null }), "amount_mismatch"],
    ["monedă EUR", () => ({ currency: "EUR" }), "currency_mismatch"],
    ["monedă lipsă", () => ({ currency: "" }), "currency_mismatch"],
  ];
  for (const [name, over, reason] of cases) {
    it(`${name} → «necesită atenție» (${reason})`, async () => {
      await cardHarness(async (h) => {
        const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
        const deps = processorDeps(h);
        await deliver(deps, paidEvent(paymentId, amountMinor, over(amountMinor)));
        const order = await orderOf(h.tx, orderId);
        expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
        expect(order.payments[0]).toMatchObject({ status: "pending", attentionReason: reason });
        expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
        expect(order.stockCommitments).toHaveLength(0);
        expect((await stockOf(h, variantId)).committed).toBe(0n);
        expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("attention");
      });
    });
  }
});

describe("webhook duplicat: un singur efect", () => {
  it("același eveniment de 3 ori = o confirmare, o angajare, un OrderEvent", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const body = paidEvent(paymentId, amountMinor);
      const first = await deliver(deps, body);
      const second = await deliver(deps, body);
      const third = await deliver(deps, body);
      expect(first.ingest.outcome).toBe("accepted");
      expect(second.ingest.outcome).toBe("duplicate");
      expect(third.ingest.outcome).toBe("duplicate");
      expect(second.processed).toBe(false);
      expect(
        await h.tx.paymentWebhookEvent.count({
          where: { provider: "demo", eventId: body.eventId },
        }),
      ).toBe(1);
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.confirmed" } })).toBe(
        1,
      );
      expect(await h.tx.stockCommitment.count({ where: { orderId } })).toBe(1);
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
    });
  });

  it("evenimente DIFERITE pentru aceeași plată (de ex. 3 apoi 5 la Netopia) = tot un singur efect", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      await deliver(deps, paidEvent(paymentId, amountMinor));
      await deliver(deps, paidEvent(paymentId, amountMinor));
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.confirmed" } })).toBe(
        1,
      );
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
    });
  });

  it("procesarea repetată a aceluiași eveniment (coadă + măturător) nu face nimic a doua oară", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const { ingest } = await deliver(deps, paidEvent(paymentId, amountMinor));
      expect((await processPaymentEvent(deps, ingest.eventId!)).status).toBe("skipped");
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.confirmed" } })).toBe(
        1,
      );
    });
  });
});

describe("plată târzie: cu stoc liber re-rezervă și confirmă, fără stoc rambursează", () => {
  async function expireReservation(h: Harness, orderId: string) {
    // trecerea timpului: jobul de stoc expiră rezervarea (cantitatea rezervată se eliberează)
    void orderId;
    await new StockService({
      db: h.tx,
      now: () => new Date(NOW.getTime() + 1_800_000),
    }).expireDue();
  }

  it("rezervarea a expirat, stocul e liber → se re-rezervă și se confirmă atomic, FĂRĂ rambursare", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      await expireReservation(h, orderId);
      const deps = processorDeps(h, { now: new Date(NOW.getTime() + 3_600_000) });
      await new StockService({ db: h.tx, now: () => deps.now() }).expireDue();
      expect((await stockOf(h, variantId)).reserved).toBe(0n);

      await deliver(deps, paidEvent(paymentId, amountMinor));
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.stockCommitments).toHaveLength(1);
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("confirmed");
    });
  });

  it("STOCK_RESERVATION_LOST: stocul s-a luat între timp → comandă anulată, o rambursare automată, mesaj pentru client, alertă", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h, {
        physical: "1",
      });
      await expireReservation(h, orderId);
      // altcineva cumpără ultima bucată (ramburs: angajare directă)
      const cod = await h.fill([{ variantId }]);
      await h.checkout.place(cod, await h.input(cod));
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));

      const deps = processorDeps(h, { now: new Date(NOW.getTime() + 3_600_000) });
      const body = paidEvent(paymentId, amountMinor);
      for (let i = 0; i < 3; i++) await deliver(deps, body); // același webhook de 3 ori

      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({
        status: "cancelled",
        fulfillmentStatus: "cancelled",
        paymentStatus: "refunded",
      });
      expect(order.stockCommitments).toHaveLength(0);
      const refunds = await h.tx.refund.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        kind: "auto_stock_lost",
        status: "confirmed",
        amountMinor,
        idempotencyKey: `auto:stock_lost:${paymentId}`,
      });
      const lost = order.events.find((e) => e.type === "payment.stock_lost");
      expect(lost?.message).toContain("Comanda a fost anulată");
      expect(lost?.message).toContain("va fi returnată");
      expect(order.events.filter((e) => e.type === "payment.stock_lost")).toHaveLength(1);
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({
        status: "refunded",
        refundCommittedMinor: amountMinor,
        attentionReason: "stock_reservation_lost",
      });
      expect(payment.attentionResolvedAt).not.toBeNull();
      expect(deps.audits).toContain("payment.stock_reservation_lost");
      // stocul celuilalt client nu a fost atins
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("refunded");
    });
  });

  it("STOCK_RESERVATION_LOST cu furnizor care cere rambursare manuală: rămâne în «necesită atenție», comanda anulată", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h, {
        physical: "1",
      });
      await expireReservation(h, orderId);
      const cod = await h.fill([{ variantId }]);
      await h.checkout.place(cod, await h.input(cod));
      const deps = processorDeps(h, {
        now: new Date(NOW.getTime() + 3_600_000),
        refundBehavior: "manual_required",
      });
      await deliver(deps, paidEvent(paymentId, amountMinor));
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "cancelled", paymentStatus: "paid" });
      const refund = await h.tx.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe("manual_required");
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.attentionReason).toBe("stock_reservation_lost");
      expect(payment.attentionResolvedAt).toBeNull();
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("refunded");
    });
  });
});

describe("webhook pe comandă deja anulată", () => {
  it("plata primită după anulare se rambursează automat o singură dată, comanda rămâne anulată", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      // anulare (de exemplu la sfârșitul ferestrei de reîncercare)
      const { transitionOrder } = await import("../orders/order-service");
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled", paymentStatus: "cancelled", fulfillmentStatus: "cancelled" },
        { type: "order.auto_cancelled", message: "anulată" },
        NOW,
      );
      const deps = processorDeps(h);
      const body = paidEvent(paymentId, amountMinor);
      await deliver(deps, body);
      await deliver(deps, body);
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
      const refunds = await h.tx.refund.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ kind: "auto_late_payment", status: "confirmed" });
      expect(await eventTypes(h, orderId)).toContain("payment.late_cancelled");
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("refunded");
    });
  });
});

describe("webhook-uri în ordine inversă", () => {
  it("«eșuat» sosit după «plătit» e ignorat", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      await deliver(deps, { ...paidEvent(paymentId, 0), outcome: "failed", amountMinor: null });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.payments[0]?.status).toBe("paid");
    });
  });

  it("«plătit» sosit după «eșuat» (aceeași tentativă) confirmă comanda, re-rezervând stocul", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, { ...paidEvent(paymentId, 0), outcome: "failed", amountMinor: null });
      expect((await stockOf(h, variantId)).reserved).toBe(0n);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect((await stockOf(h, variantId)).committed).toBe(q("1"));
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("confirmed");
    });
  });
});

describe("înregistrarea evenimentelor respinse și a celor pierdute", () => {
  it("fără semnătură sau cu semnătură greșită: respins, înregistrat fără conținut, fără niciun efect", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      const body = paidEvent(paymentId, amountMinor);
      const signed = demoRequest(body);
      const forged = await ingestPaymentWebhook(deps, "demo", {
        headers: {},
        rawBody: signed.rawBody,
      });
      const wrong = await ingestPaymentWebhook(
        deps,
        "demo",
        demoRequest(body, "alta-cheie-de-test-generata-in-test-1234"),
      );
      expect(forged).toMatchObject({ outcome: "rejected", status: 401 });
      expect(wrong).toMatchObject({ outcome: "rejected", status: 401 });
      const rejected = await h.tx.paymentWebhookEvent.findMany({ where: { status: "rejected" } });
      expect(rejected.map((e) => e.rejectReason).sort()).toEqual([
        "signature_invalid",
        "signature_missing",
      ]);
      for (const event of rejected) {
        expect(event.normalized).toBeNull();
        expect(event.bodyHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(event)).not.toContain(paymentId);
      }
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
      expect(order.payments[0]?.status).toBe("pending");
    });
  });

  it("furnizor neconfigurat: respins cu motiv «not_configured»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const result = await ingestPaymentWebhook(deps, "netopia", {
        headers: {},
        rawBody: Buffer.from("{}"),
      });
      expect(result.outcome).toBe("rejected");
      const row = await h.tx.paymentWebhookEvent.findFirstOrThrow({
        where: { provider: "netopia" },
      });
      expect(row.rejectReason).toBe("not_configured");
    });
  });

  it("plată necunoscută: evenimentul rămâne «failed» cu motiv, vizibil; reîncercarea și dead-letter-ul se numără", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const ingest = await ingestPaymentWebhook(
        deps,
        "demo",
        demoRequest(paidEvent("plata-inexistenta", 100)),
      );
      await expect(processPaymentEvent(deps, ingest.eventId!)).rejects.toThrow("PAYMENT_NOT_FOUND");
      const row = await h.tx.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: ingest.eventId! },
      });
      expect(row).toMatchObject({ status: "failed", attempts: 1, lastError: "PAYMENT_NOT_FOUND" });
      expect(row.processedAt).toBeNull();
      // măturătorul îl reia, dar nu depășește numărul maxim de încercări
      for (let i = 0; i < 10; i++) await sweepPaymentEvents(deps, { olderThanMs: 0 });
      const after = await h.tx.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: ingest.eventId! },
      });
      expect(after.status).toBe("failed");
      expect(after.attempts).toBe(6);
    });
  });

  it("măturătorul procesează un eveniment rămas «received» (coada indisponibilă)", async () => {
    await cardHarness(async (h) => {
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      deps.enqueue = async () => {
        throw new Error("Redis indisponibil");
      };
      const ingest = await ingestPaymentWebhook(
        deps,
        "demo",
        demoRequest(paidEvent(paymentId, amountMinor)),
      );
      expect(ingest.outcome).toBe("accepted");
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
      const swept = await sweepPaymentEvents(deps, { olderThanMs: 0 });
      expect(swept.processed).toBe(1);
      expect((await orderOf(h.tx, orderId)).status).toBe("confirmed");
    });
  });

  it("referința plății aparține altui furnizor: nu se aplică (verificare încrucișată)", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      await h.tx.payment.update({ where: { id: paymentId }, data: { provider: "euplatesc" } });
      const deps = processorDeps(h);
      const ingest = await ingestPaymentWebhook(
        deps,
        "demo",
        demoRequest(paidEvent(paymentId, amountMinor)),
      );
      await expect(processPaymentEvent(deps, ingest.eventId!)).rejects.toThrow("PAYMENT_NOT_FOUND");
      expect((await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
        "pending",
      );
    });
  });
});

describe("INVARIANT: niciun ban confirmat de procesator nu rămâne fără stare", () => {
  type OrderState = "pending" | "cancelled" | "already_paid";
  type StockCase = "free" | "taken";
  const orderStates: OrderState[] = ["pending", "cancelled", "already_paid"];
  const stocks: StockCase[] = ["free", "taken"];
  const amounts = ["exact", "less", "more", "missing"] as const;
  const currencies = ["RON", "EUR"] as const;
  const behaviors = ["confirmed", "manual_required", "failed", "pending"] as const;

  for (const orderState of orderStates) {
    for (const stock of stocks) {
      for (const amount of amounts) {
        for (const currency of currencies) {
          for (const behavior of behaviors) {
            if (stock === "taken" && orderState !== "pending") continue;
            it(`comandă ${orderState}, stoc ${stock}, sumă ${amount}, ${currency}, rambursare ${behavior} → plata are stare`, async () => {
              await cardHarness(async (h) => {
                const { orderId, paymentId, variantId, amountMinor } = await placeCardOrder(h, {
                  physical: "1",
                });
                const { transitionOrder } = await import("../orders/order-service");
                if (orderState === "cancelled") {
                  await transitionOrder(
                    h.tx,
                    orderId,
                    {
                      status: "cancelled",
                      paymentStatus: "cancelled",
                      fulfillmentStatus: "cancelled",
                    },
                    { type: "order.auto_cancelled", message: "anulată" },
                    NOW,
                  );
                }
                if (stock === "taken") {
                  await new StockService({
                    db: h.tx,
                    now: () => new Date(NOW.getTime() + 1_800_000),
                  }).expireDue();
                  const cod = await h.fill([{ variantId }]);
                  await h.checkout.place(cod, await h.input(cod));
                }
                const deps = processorDeps(h, {
                  now: new Date(NOW.getTime() + 3_600_000),
                  refundBehavior: behavior,
                });
                if (orderState === "already_paid") {
                  const second = await h.tx.payment.create({
                    data: {
                      orderId,
                      provider: "demo",
                      method: "card",
                      amountMinor,
                      attemptNo: 2,
                      mode: "demo",
                    },
                  });
                  await deliver(deps, paidEvent(paymentId, amountMinor));
                  await deliver(deps, eventFor(second.id));
                  expect(await checkMoneyInvariant(h.tx, second.id)).not.toBe("violation");
                } else {
                  await deliver(deps, eventFor(paymentId));
                }
                expect(await checkMoneyInvariant(h.tx, paymentId)).not.toBe("violation");

                function eventFor(id: string) {
                  const over: Record<string, unknown> = {};
                  if (amount === "less") over["amountMinor"] = amountMinor - 1;
                  if (amount === "more") over["amountMinor"] = amountMinor + 1;
                  if (amount === "missing") over["amountMinor"] = null;
                  over["currency"] = currency;
                  return paidEvent(id, amountMinor, over);
                }
              });
            });
          }
        }
      }
    }
  }
});

describe("semnătura DEMO folosește cheia de test generată din APP_KEY", () => {
  it("cheia nu e o valoare scrisă în cod și nu apare în evenimentele înregistrate", async () => {
    await cardHarness(async (h) => {
      const { paymentId, amountMinor } = await placeCardOrder(h);
      const deps = processorDeps(h);
      await deliver(deps, paidEvent(paymentId, amountMinor));
      const events = await h.tx.paymentWebhookEvent.findMany();
      expect(JSON.stringify(events)).not.toContain(SIGNING_KEY);
    });
  });
});

void ORDER_REF_TYPE;
