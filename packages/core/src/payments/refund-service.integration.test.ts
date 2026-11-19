import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { PaymentProvider, RefundRequest } from "@ecom/shared";
import { codeOf, NOW, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
  type TestDeps,
} from "../test-utils/payment-fixtures";
import { checkMoneyInvariant } from "./money-invariant";
import {
  confirmManualRefund,
  executeRefund,
  requestRefund,
  sweepRefunds,
  type RefundDeps,
} from "./refund-service";

/** Faza 10, rambursările: plafon, idempotență, stări (cerută, confirmată, eșuată, manuală), măturătorul și notificarea de credit. */
const db = getDb();
afterAll(() => db.$disconnect());

async function paidOrder(h: Harness, deps: TestDeps) {
  const placed = await placeCardOrder(h);
  await deliver(deps, paidEvent(placed.paymentId, placed.amountMinor));
  return placed;
}

/** Furnizor care numără apelurile de rambursare. */
function counting(
  deps: TestDeps,
  behavior?: "confirmed" | "pending" | "failed" | "manual_required",
) {
  const calls: RefundRequest[] = [];
  const base = deps.provider;
  const provider: PaymentProvider = {
    code: base.code,
    mode: base.mode,
    createPayment: (i) => base.createPayment(i),
    verifyWebhook: (r) => base.verifyWebhook(r),
    capture: (ref, amount) => base.capture(ref, amount),
    refund: async (request) => {
      calls.push(request);
      if (behavior === "confirmed" || behavior === undefined) {
        return { status: "confirmed", providerRef: "p-1" };
      }
      if (behavior === "pending") return { status: "pending", providerRef: "p-2" };
      if (behavior === "failed") return { status: "failed", message: "refuzat" };
      return { status: "manual_required", message: "manual" };
    },
    getStatus: (ref) => base.getStatus(ref),
    testConnection: () => base.testConnection(),
  };
  return { calls, provider };
}

function refundDeps(h: Harness, deps: TestDeps, provider: PaymentProvider): RefundDeps {
  return { db: h.tx, getProvider: async () => provider, now: () => deps.clock.now };
}

const ask = (paymentId: string, amountMinor: number, key: string, reason = "Produs returnat") => ({
  paymentId,
  amountMinor,
  reason,
  idempotencyKey: key,
  actorLabel: "admin@exemplu.ro",
});

describe("rambursare parțială și totală", () => {
  it("parțial apoi restul: paymentStatus trece paid → partially_refunded → refunded doar prin state machine", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await paidOrder(h, deps);
      const { calls, provider } = counting(deps);
      const rd = refundDeps(h, deps, provider);

      const first = await requestRefund(rd, ask(paymentId, 1_000, "k1"));
      expect(first.created).toBe(true);
      let order = await orderOf(h.tx, orderId);
      expect(order.paymentStatus).toBe("partially_refunded");
      let payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({ status: "paid", refundCommittedMinor: 1_000 });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        amountMinor: 1_000,
        paymentAmountMinor: amountMinor,
        currency: "RON",
      });

      await requestRefund(rd, ask(paymentId, amountMinor - 1_000, "k2"));
      order = await orderOf(h.tx, orderId);
      expect(order.paymentStatus).toBe("refunded");
      payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({ status: "refunded", refundCommittedMinor: amountMinor });
      expect(order.events.filter((e) => e.type === "payment.refunded")).toHaveLength(2);
      expect(order.status).toBe("confirmed"); // rambursarea face DOAR banii: nu atinge comanda, stocul sau returul
      expect(await h.tx.stockCommitment.count({ where: { orderId, status: "open" } })).toBe(1);
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("refunded");
    });
  });

  it("aceeași cheie de idempotență nu rambursează de două ori", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId } = await paidOrder(h, deps);
      const { calls, provider } = counting(deps);
      const rd = refundDeps(h, deps, provider);
      const a = await requestRefund(rd, ask(paymentId, 500, "same"));
      const b = await requestRefund(rd, ask(paymentId, 500, "same"));
      expect(b).toEqual({ refundId: a.refundId, created: false });
      expect(calls).toHaveLength(1);
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundCommittedMinor,
      ).toBe(500);
    });
  });

  it("refuză: peste suma rămasă, sumă nepozitivă, motiv gol, plată neîncasată, plată inexistentă", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId, amountMinor } = await paidOrder(h, deps);
      const { provider } = counting(deps);
      const rd = refundDeps(h, deps, provider);
      expect(await codeOf(requestRefund(rd, ask(paymentId, amountMinor + 1, "x1")))).toBe(
        "REFUND_EXCEEDS_PAID",
      );
      await requestRefund(rd, ask(paymentId, amountMinor - 100, "x2"));
      expect(await codeOf(requestRefund(rd, ask(paymentId, 101, "x3")))).toBe(
        "REFUND_EXCEEDS_PAID",
      );
      expect(await codeOf(requestRefund(rd, ask(paymentId, 0, "x4")))).toBe("REFUND_INVALID");
      expect(await codeOf(requestRefund(rd, ask(paymentId, -5, "x5")))).toBe("REFUND_INVALID");
      expect(await codeOf(requestRefund(rd, ask(paymentId, 1.5, "x6")))).toBe("REFUND_INVALID");
      expect(await codeOf(requestRefund(rd, ask(paymentId, 100, "x7", "   ")))).toBe(
        "REFUND_INVALID",
      );
      expect(await codeOf(requestRefund(rd, ask("nu-exista", 100, "x8")))).toBe(
        "PAYMENT_NOT_FOUND",
      );
      const unpaid = await placeCardOrder(h);
      expect(await codeOf(requestRefund(rd, ask(unpaid.paymentId, 100, "x9")))).toBe(
        "PAYMENT_NOT_REFUNDABLE",
      );
      // și la limită exactă trece
      await requestRefund(rd, ask(paymentId, 100, "x10"));
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundCommittedMinor,
      ).toBe(amountMinor);
    });
  });
});

describe("rambursare eșuată sau în așteptare: stare vizibilă, nu pierdută", () => {
  it("eșuată: suma nu mai e angajată (se poate cere din nou), plata intră în «necesită atenție»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId } = await paidOrder(h, deps);
      const { provider } = counting(deps, "failed");
      const rd = refundDeps(h, deps, provider);
      const { refundId } = await requestRefund(rd, ask(paymentId, 2_000, "f1"));
      const refund = await h.tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      expect(refund).toMatchObject({ status: "failed", failureMessage: "refuzat" });
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({ refundCommittedMinor: 0, attentionReason: "refund_failed" });
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("paid");
      // o nouă cerere (altă cheie) merge
      const ok = counting(deps);
      await requestRefund(refundDeps(h, deps, ok.provider), ask(paymentId, 2_000, "f2"));
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundCommittedMinor,
      ).toBe(2_000);
    });
  });

  it("«manuală necesară»: suma rămâne angajată, plata vizibilă; «am rambursat manual» o închide (cu referință și audit la apelant)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await paidOrder(h, deps);
      const { provider } = counting(deps, "manual_required");
      const rd = refundDeps(h, deps, provider);
      const { refundId } = await requestRefund(rd, ask(paymentId, amountMinor, "m1"));
      let refund = await h.tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      expect(refund.status).toBe("manual_required");
      let payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({
        refundCommittedMinor: amountMinor,
        attentionReason: "refund_manual_required",
        status: "paid",
      });
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("paid"); // abia după confirmare trece prin state machine

      expect(
        await codeOf(confirmManualRefund(rd, { refundId, reference: "  ", actorLabel: "a" })),
      ).toBe("REFUND_INVALID");
      refund = await confirmManualRefund(rd, {
        refundId,
        reference: "TX-998877",
        actorLabel: "admin@exemplu.ro",
      });
      expect(refund).toMatchObject({
        status: "confirmed",
        resolvedManually: true,
        manualReference: "TX-998877",
      });
      payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment).toMatchObject({ status: "refunded" });
      expect(payment.attentionResolvedAt).not.toBeNull();
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("refunded");
      // idempotent
      const again = await confirmManualRefund(rd, {
        refundId,
        reference: "TX-998877",
        actorLabel: "a",
      });
      expect(again.status).toBe("confirmed");
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.refunded" } })).toBe(1);
    });
  });

  it("doar o rambursare «manuală» (sau trimisă și neconfirmată) se poate confirma manual", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId } = await paidOrder(h, deps);
      const { provider } = counting(deps, "failed");
      const rd = refundDeps(h, deps, provider);
      const { refundId } = await requestRefund(rd, ask(paymentId, 100, "n1"));
      expect(
        await codeOf(confirmManualRefund(rd, { refundId, reference: "R", actorLabel: "a" })),
      ).toBe("REFUND_NOT_MANUAL");
      expect(
        await codeOf(
          confirmManualRefund(rd, { refundId: "nu-exista", reference: "R", actorLabel: "a" }),
        ),
      ).toBe("REFUND_NOT_FOUND");
    });
  });

  it("«în așteptare» la procesator: rămâne cerută și trimisă; nu se retrimite; după termen devine «manuală» (fără retrimitere)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId } = await paidOrder(h, deps);
      const { calls, provider } = counting(deps, "pending");
      const rd = refundDeps(h, deps, provider);
      const { refundId } = await requestRefund(rd, ask(paymentId, 3_000, "p1"));
      let refund = await h.tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      expect(refund).toMatchObject({ status: "requested", providerRef: "p-2" });
      expect(refund.sentAt).not.toBeNull();
      await executeRefund(rd, refundId);
      await executeRefund(rd, refundId);
      expect(calls).toHaveLength(1);

      const early = await sweepRefunds(rd, { staleMs: 3_600_000, unsentAfterMs: 60_000 });
      expect(early).toEqual({ sent: 0, escalated: 0 });
      deps.clock.now = new Date(NOW.getTime() + 2 * 3_600_000);
      const late = await sweepRefunds(rd, { staleMs: 3_600_000, unsentAfterMs: 60_000 });
      expect(late.escalated).toBe(1);
      refund = await h.tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      expect(refund.status).toBe("manual_required");
      expect(calls).toHaveLength(1);
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).attentionReason,
      ).toBe("refund_manual_required");
    });
  });

  it("o cerere netrimisă (proces oprit între creare și trimitere) e trimisă de măturător, o singură dată", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId, orderId } = await paidOrder(h, deps);
      const { calls, provider } = counting(deps);
      const rd = refundDeps(h, deps, provider);
      const { refund } = await (
        await import("./refund-service")
      ).createRefundInTx(
        h.tx,
        {
          paymentId,
          amountMinor: 700,
          reason: "Netrimisă",
          kind: "admin",
          idempotencyKey: "u1",
        },
        NOW,
      );
      expect(refund.sentAt).toBeNull();
      deps.clock.now = new Date(NOW.getTime() + 5 * 60_000);
      const swept = await sweepRefunds(rd, { staleMs: 3_600_000, unsentAfterMs: 60_000 });
      expect(swept.sent).toBe(1);
      expect(calls).toHaveLength(1);
      await sweepRefunds(rd, { staleMs: 3_600_000, unsentAfterMs: 60_000 });
      expect(calls).toHaveLength(1);
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("partially_refunded");
    });
  });

  it("notificarea de credit confirmă o rambursare «manuală» cu aceeași sumă; una fără pereche cere atenție", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { paymentId, orderId } = await paidOrder(h, deps);
      const { provider } = counting(deps, "manual_required");
      const rd = refundDeps(h, deps, provider);
      const { refundId } = await requestRefund(rd, ask(paymentId, 4_000, "c1"));
      await deliver(deps, { ...paidEvent(paymentId, 4_000), outcome: "credit" });
      expect((await h.tx.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(
        "confirmed",
      );
      expect((await orderOf(h.tx, orderId)).paymentStatus).toBe("partially_refunded");

      await deliver(deps, { ...paidEvent(paymentId, 123), outcome: "credit" });
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.attentionReason).toBe("credit_unmatched");
    });
  });
});
