import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 10, schema plăților. Fiecare constrângere nouă are un test care o încalcă, iar CHECK-urile compuse au și cazul «una
 * setată, una nulă» (un CHECK cu rezultat NULL TRECE). Extinderea pentru «card» e un superset strict: ce era valid rămâne valid
 * (combinațiile metodă × reservationExpiresAt × paymentRetryDeadlineAt sunt enumerate). Testele își creează singure datele,
 * într-o tranzacție anulată, și nu presupun seed.
 */
const db = getDb();
afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function channel(tx: TestTx) {
  return tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal test" } });
}

function orderData(channelId: string, over: Record<string, unknown> = {}) {
  return {
    number: `T-${uid()}`,
    channelId,
    email: "client@exemplu.ro",
    phone: "0722000000",
    subtotalMinor: 10_000,
    shippingMinor: 1_500,
    codFeeMinor: 0,
    shippingTaxMinor: 260,
    codFeeTaxMinor: 0,
    taxMinor: 1_995,
    totalMinor: 11_500,
    taxRateBps: 2100,
    shippingMethodCode: "courier",
    shippingSnapshot: { carrier: "demo" },
    paymentMethod: "card",
    termsAcceptedAt: new Date(),
    termsConsentText: "Sunt de acord cu Termenii",
    termsConsentVersion: "provizoriu-1",
    idempotencyKey: randomUUID(),
    ...over,
  };
}

async function attempt<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<Error | null> {
  return inRolledBackTransaction(db, async (tx) => {
    const b = await setup(tx);
    try {
      await act(tx, b);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

async function rejects<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
  expected: string,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

async function accepts<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, String(error?.message)).toBeNull();
}

const later = () => new Date(Date.now() + 3_600_000);

describe("comanda cu card: reguli extinse, superset strict", () => {
  // metodă × reservationExpiresAt × paymentRetryDeadlineAt → acceptat?
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ["cod", false, false, true],
    ["cod", true, false, false],
    ["cod", false, true, false],
    ["cod", true, true, false],
    ["bank_transfer", true, false, true],
    ["bank_transfer", false, false, false],
    ["bank_transfer", true, true, false],
    ["bank_transfer", false, true, false],
    ["card", true, true, true],
    ["card", true, false, false],
    ["card", false, true, false],
    ["card", false, false, false],
  ];
  for (const [method, reserved, retry, ok] of cases) {
    it(`${method}, rezervare ${reserved ? "setată" : "nulă"}, reîncercare ${retry ? "setată" : "nulă"} → ${ok ? "acceptat" : "respins"}`, async () => {
      const data = (channelId: string) =>
        orderData(channelId, {
          paymentMethod: method,
          ...(method === "cod"
            ? {
                codFeeMinor: 500,
                codFeeTaxMinor: 87,
                taxMinor: 2_082,
                totalMinor: 12_000,
              }
            : {}),
          reservationExpiresAt: reserved ? later() : null,
          paymentRetryDeadlineAt: retry ? later() : null,
        });
      if (ok) await accepts(channel, (tx, c) => tx.order.create({ data: data(c.id) }));
      else
        await rejects(
          channel,
          (tx, c) => tx.order.create({ data: data(c.id) }),
          method === "card" && reserved
            ? "customer_order_retry_deadline_check"
            : method === "cod" && retry && !reserved
              ? "customer_order_retry_deadline_check"
              : "customer_order_",
        );
    });
  }

  it("o metodă necunoscută rămâne respinsă", async () => {
    await rejects(
      channel,
      (tx, c) => tx.order.create({ data: orderData(c.id, { paymentMethod: "paypal" }) }),
      "customer_order_payment_method_check",
    );
  });

  it("cardul nu poate avea taxă de ramburs", async () => {
    await rejects(
      channel,
      (tx, c) =>
        tx.order.create({
          data: orderData(c.id, {
            codFeeMinor: 500,
            codFeeTaxMinor: 87,
            taxMinor: 2_082,
            totalMinor: 12_000,
            reservationExpiresAt: later(),
            paymentRetryDeadlineAt: later(),
          }),
        }),
      "customer_order_cod_fee_check",
    );
  });

  it("o comandă cu card nu poate pierde rezervarea curentă", async () => {
    await rejects(
      async (tx) => {
        const c = await channel(tx);
        return tx.order.create({
          data: orderData(c.id, {
            reservationExpiresAt: later(),
            paymentRetryDeadlineAt: later(),
          }),
        });
      },
      (tx, o) => tx.order.update({ where: { id: o.id }, data: { reservationExpiresAt: null } }),
      "customer_order_reservation_check",
    );
  });
});

async function withOrder(tx: TestTx) {
  const c = await channel(tx);
  return tx.order.create({
    data: orderData(c.id, { reservationExpiresAt: later(), paymentRetryDeadlineAt: later() }),
  });
}

const pay = (orderId: string, over: Record<string, unknown> = {}) => ({
  orderId,
  provider: "demo",
  method: "card",
  amountMinor: 11_500,
  ...over,
});

describe("plata (tentativa)", () => {
  it("acceptă furnizorii noi și refuză unul necunoscut", async () => {
    for (const provider of ["netopia", "euplatesc", "demo"]) {
      await accepts(withOrder, (tx, o) => tx.payment.create({ data: pay(o.id, { provider }) }));
    }
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { provider: "card" }) }),
      "payment_provider_check",
    );
  });

  it("o tentativă are număr unic per comandă; tentativele diferă prin număr", async () => {
    await rejects(
      withOrder,
      async (tx, o) => {
        await tx.payment.create({ data: pay(o.id) });
        await tx.payment.create({ data: pay(o.id) });
      },
      "payment_orderId_attemptNo_key",
    );
    await accepts(withOrder, async (tx, o) => {
      await tx.payment.create({ data: pay(o.id, { attemptNo: 1 }) });
      await tx.payment.create({ data: pay(o.id, { attemptNo: 2 }) });
    });
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { attemptNo: 0 }) }),
      "payment_attempt_check",
    );
  });

  it("referința procesatorului e unică per furnizor", async () => {
    await rejects(
      async (tx) => {
        const a = await withOrder(tx);
        const b = await withOrder(tx);
        return { a, b };
      },
      async (tx, { a, b }) => {
        await tx.payment.create({ data: pay(a.id, { providerRef: "REF-1" }) });
        await tx.payment.create({ data: pay(b.id, { providerRef: "REF-1" }) });
      },
      "payment_provider_providerRef_key",
    );
  });

  it("modul și ultimele 4 cifre au format valid", async () => {
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { mode: "prod" }) }),
      "payment_mode_check",
    );
    await accepts(withOrder, (tx, o) =>
      tx.payment.create({ data: pay(o.id, { mode: "test", cardLast4: "4242" }) }),
    );
    for (const cardLast4 of ["424", "42424", "abcd", "4111111111111111"]) {
      await rejects(
        withOrder,
        (tx, o) => tx.payment.create({ data: pay(o.id, { cardLast4 }) }),
        "payment_card_last4_check",
      );
    }
  });

  it("suma confirmată e pozitivă sau nulă (negestionată)", async () => {
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { capturedAmountMinor: 0 }) }),
      "payment_captured_amount_check",
    );
  });

  it("rambursările angajate nu pot depăși suma plății și cer o plată încasată", async () => {
    await rejects(
      withOrder,
      (tx, o) =>
        tx.payment.create({
          data: pay(o.id, { status: "paid", capturedAt: new Date(), refundCommittedMinor: 11_501 }),
        }),
      "payment_refund_cap_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { refundCommittedMinor: -1 }) }),
      "payment_refund_cap_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { refundCommittedMinor: 100 }) }),
      "payment_refund_requires_capture_check",
    );
    await accepts(withOrder, (tx, o) =>
      tx.payment.create({
        data: pay(o.id, { status: "paid", capturedAt: new Date(), refundCommittedMinor: 11_500 }),
      }),
    );
  });

  it("«necesită atenție»: motivul și momentul vin împreună («una setată, una nulă»)", async () => {
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { attentionReason: "amount_mismatch" }) }),
      "payment_attention_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { attentionAt: new Date() }) }),
      "payment_attention_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { attentionResolvedAt: new Date() }) }),
      "payment_attention_check",
    );
    await accepts(withOrder, (tx, o) =>
      tx.payment.create({
        data: pay(o.id, { attentionReason: "amount_mismatch", attentionAt: new Date() }),
      }),
    );
  });
});

async function withPayment(tx: TestTx) {
  const order = await withOrder(tx);
  const payment = await tx.payment.create({
    data: pay(order.id, { status: "paid", capturedAt: new Date() }),
  });
  return { order, payment };
}

const refund = (paymentId: string, orderId: string, over: Record<string, unknown> = {}) => ({
  paymentId,
  orderId,
  amountMinor: 1_000,
  reason: "Produs returnat",
  kind: "admin",
  idempotencyKey: randomUUID(),
  ...over,
});

describe("rambursarea", () => {
  it("acceptă o rambursare cerută", async () => {
    await accepts(withPayment, (tx, { order, payment }) =>
      tx.refund.create({ data: refund(payment.id, order.id) }),
    );
  });

  it("refuză stări și tipuri necunoscute, sume nepozitive și motiv gol", async () => {
    const act =
      (over: Record<string, unknown>) => (tx: TestTx, b: Awaited<ReturnType<typeof withPayment>>) =>
        tx.refund.create({ data: refund(b.payment.id, b.order.id, over) });
    await rejects(withPayment, act({ status: "done" }), "refund_status_check");
    await rejects(withPayment, act({ kind: "x" }), "refund_kind_check");
    await rejects(withPayment, act({ amountMinor: 0 }), "refund_amount_check");
    await rejects(withPayment, act({ amountMinor: -5 }), "refund_amount_check");
    await rejects(withPayment, act({ reason: "   " }), "refund_reason_check");
  });

  it("«confirmată» cere momentul confirmării, iar celelalte stări nu îl au (una setată, una nulă)", async () => {
    const act =
      (over: Record<string, unknown>) => (tx: TestTx, b: Awaited<ReturnType<typeof withPayment>>) =>
        tx.refund.create({ data: refund(b.payment.id, b.order.id, over) });
    await rejects(withPayment, act({ status: "confirmed" }), "refund_confirmed_check");
    await rejects(
      withPayment,
      act({ status: "requested", confirmedAt: new Date() }),
      "refund_confirmed_check",
    );
    await accepts(withPayment, act({ status: "confirmed", confirmedAt: new Date() }));
    await accepts(withPayment, act({ status: "manual_required" }));
    await accepts(withPayment, act({ status: "failed", failureMessage: "refuzat" }));
  });

  it("cheia de idempotență e unică: o a doua rambursare cu aceeași cheie e respinsă", async () => {
    await rejects(
      withPayment,
      async (tx, { order, payment }) => {
        await tx.refund.create({ data: refund(payment.id, order.id, { idempotencyKey: "k-1" }) });
        await tx.refund.create({ data: refund(payment.id, order.id, { idempotencyKey: "k-1" }) });
      },
      "refund_idempotencyKey_key",
    );
  });
});

describe("evenimentele webhook", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    provider: "demo",
    eventId: `e-${uid()}`,
    bodyHash: "a".repeat(64),
    ...over,
  });

  it("acceptă un eveniment primit și unul respins cu motiv", async () => {
    await accepts(
      async () => undefined,
      (tx) => tx.paymentWebhookEvent.create({ data: event() }),
    );
    await accepts(
      async () => undefined,
      (tx) =>
        tx.paymentWebhookEvent.create({
          data: event({ status: "rejected", rejectReason: "signature", processedAt: new Date() }),
        }),
    );
  });

  it("unicitate pe (furnizor, eventId): același eveniment a doua oară e respins", async () => {
    await rejects(
      async () => undefined,
      async (tx) => {
        await tx.paymentWebhookEvent.create({ data: event({ eventId: "E1" }) });
        await tx.paymentWebhookEvent.create({ data: event({ eventId: "E1" }) });
      },
      "payment_webhook_event_provider_eventId_key",
    );
    await accepts(
      async () => undefined,
      async (tx) => {
        await tx.paymentWebhookEvent.create({ data: event({ eventId: "E1" }) });
        await tx.paymentWebhookEvent.create({
          data: event({ eventId: "E1", provider: "euplatesc" }),
        });
      },
    );
  });

  it("starea, motivul respingerii, momentul procesării și hash-ul sunt păzite (una setată, una nulă)", async () => {
    const make = (over: Record<string, unknown>) => (tx: TestTx) =>
      tx.paymentWebhookEvent.create({ data: event(over) });
    const none = async () => undefined;
    await rejects(none, make({ status: "x" }), "payment_webhook_event_");
    await rejects(
      none,
      make({ status: "rejected", processedAt: new Date() }),
      "payment_webhook_event_reject_check",
    );
    await rejects(none, make({ rejectReason: "signature" }), "payment_webhook_event_reject_check");
    await rejects(
      none,
      make({ status: "rejected", rejectReason: "signature" }),
      "payment_webhook_event_processed_check",
    );
    await rejects(none, make({ status: "processed" }), "payment_webhook_event_processed_check");
    await rejects(
      none,
      make({ status: "received", processedAt: new Date() }),
      "payment_webhook_event_processed_check",
    );
    await accepts(none, make({ status: "processed", processedAt: new Date() }));
    await rejects(none, make({ bodyHash: "ABC" }), "payment_webhook_event_hash_check");
    await rejects(none, make({ bodyHash: "A".repeat(64) }), "payment_webhook_event_hash_check");
    await rejects(none, make({ attempts: -1 }), "payment_webhook_event_attempts_check");
  });
});

describe("jetonul de reîncercare", () => {
  it("păstrează doar amprenta SHA-256 (hex, 64) și e unic", async () => {
    await accepts(withOrder, (tx, o) =>
      tx.paymentRetryToken.create({
        data: { orderId: o.id, tokenHash: "b".repeat(64), expiresAt: later() },
      }),
    );
    await rejects(
      withOrder,
      (tx, o) =>
        tx.paymentRetryToken.create({
          data: { orderId: o.id, tokenHash: "jeton-in-clar", expiresAt: later() },
        }),
      "payment_retry_token_hash_check",
    );
    await rejects(
      withOrder,
      async (tx, o) => {
        await tx.paymentRetryToken.create({
          data: { orderId: o.id, tokenHash: "c".repeat(64), expiresAt: later() },
        });
        await tx.paymentRetryToken.create({
          data: { orderId: o.id, tokenHash: "c".repeat(64), expiresAt: later() },
        });
      },
      "payment_retry_token_tokenHash_key",
    );
  });
});
