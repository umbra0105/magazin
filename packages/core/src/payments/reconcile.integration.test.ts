import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { PaymentProvider, ProviderStatus } from "@ecom/shared";
import { NOW, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  placeCardOrder,
  processorDeps,
  type TestDeps,
} from "../test-utils/payment-fixtures";
import { checkMoneyInvariant } from "./money-invariant";
import { reconcilePayments } from "./reconcile";

/** Faza 10, reconcilierea zilnică: cazurile sigure trec prin calea webhook-ului, restul cer atenție; furnizor picat ≠ comandă pierdută. */
const db = getDb();
afterAll(() => db.$disconnect());

const OPTIONS = { minAgeMs: 60 * 60_000, maxAgeMs: 72 * 3_600_000 };

function withStatus(
  deps: TestDeps,
  answer: (ref: {
    providerRef: string | null;
    paymentRef: string;
  }) => Promise<ProviderStatus | null>,
): TestDeps {
  const base = deps.provider;
  const provider: PaymentProvider = {
    code: base.code,
    mode: base.mode,
    createPayment: (i) => base.createPayment(i),
    verifyWebhook: (r) => base.verifyWebhook(r),
    capture: (ref, amount) => base.capture(ref, amount),
    refund: (r) => base.refund(r),
    getStatus: answer,
    testConnection: () => base.testConnection(),
  };
  return { ...deps, getProvider: async () => provider };
}

async function aged(h: Harness, deps: TestDeps) {
  const placed = await placeCardOrder(h);
  await h.tx.payment.update({ where: { id: placed.paymentId }, data: { createdAt: NOW } });
  deps.clock.now = new Date(NOW.getTime() + 2 * 3_600_000);
  return placed;
}

describe("reconcilierea zilnică", () => {
  it("«plătit» cu suma cunoscută: aceeași cale idempotentă ca webhook-ul (comandă confirmată, un singur efect, și la a doua rulare)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await aged(h, deps);
      const d = withStatus(deps, async ({ paymentRef }) => ({
        outcome: "paid",
        providerRef: "P1",
        amountMinor,
        currency: "RON",
        rawStatus: `ref=${paymentRef}`,
      }));
      const first = await reconcilePayments(d, OPTIONS);
      expect(first).toMatchObject({ checked: 1, applied: 1, unsupported: 0, unavailable: 0 });
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        status: "confirmed",
        paymentStatus: "paid",
      });
      const second = await reconcilePayments(d, OPTIONS);
      expect(second.checked).toBe(0); // plata nu mai e «pending»
      expect(await h.tx.orderEvent.count({ where: { orderId, type: "payment.confirmed" } })).toBe(
        1,
      );
      expect(await checkMoneyInvariant(h.tx, paymentId)).toBe("confirmed");
    });
  });

  it("«eșuat» la procesator: tentativa devine «failed» (comanda rămâne în așteptare)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId } = await aged(h, deps);
      const d = withStatus(deps, async () => ({
        outcome: "failed",
        providerRef: null,
        amountMinor: null,
        currency: null,
        rawStatus: "action=5",
      }));
      await reconcilePayments(d, OPTIONS);
      expect((await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
        "failed",
      );
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
    });
  });

  it("sumă diferită la procesator: trece prin aceeași verificare a sumei, intră în «necesită atenție», fără confirmare", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await aged(h, deps);
      const d = withStatus(deps, async () => ({
        outcome: "paid",
        providerRef: "P",
        amountMinor: amountMinor - 5,
        currency: "RON",
        rawStatus: "x",
      }));
      await reconcilePayments(d, OPTIONS);
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).attentionReason,
      ).toBe("amount_mismatch");
    });
  });

  it("«plătit» fără sumă cunoscută: NU se repară pe tăcute; apare în raport și în «necesită atenție»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId } = await aged(h, deps);
      const d = withStatus(deps, async () => ({
        outcome: "paid",
        providerRef: "P",
        amountMinor: null,
        currency: null,
        rawStatus: "action=0",
      }));
      const report = await reconcilePayments(d, OPTIONS);
      expect(report.mismatches).toEqual([{ paymentId, reason: "suma tranzacției nu e cunoscută" }]);
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).attentionReason,
      ).toBe("reconciliation_mismatch");
    });
  });

  it("furnizor care nu poate da starea (null): sărit și numărat, nimic modificat", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await aged(h, deps);
      const report = await reconcilePayments(
        withStatus(deps, async () => null),
        OPTIONS,
      );
      expect(report).toMatchObject({ checked: 1, unsupported: 1, applied: 0 });
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
    });
  });

  it("furnizor picat: nimic nu se pierde, circuit breaker după 3 eșecuri la rând, plățile rămân pentru rularea următoare", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const orders = [];
      for (let i = 0; i < 5; i++) orders.push(await aged(h, deps));
      let calls = 0;
      const d = withStatus(deps, async () => {
        calls += 1;
        throw new Error("procesator picat");
      });
      const report = await reconcilePayments(d, OPTIONS);
      expect(calls).toBe(3);
      expect(report).toMatchObject({ unavailable: 3, skippedByBreaker: 2, applied: 0 });
      for (const o of orders) {
        expect((await orderOf(h.tx, o.orderId)).status).toBe("pending");
        expect((await h.tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).status).toBe(
          "pending",
        );
      }
    });
  });

  it("ignoră plățile prea noi (în curs) și pe cele prea vechi", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const fresh = await placeCardOrder(h);
      await h.tx.payment.update({ where: { id: fresh.paymentId }, data: { createdAt: NOW } });
      const old = await placeCardOrder(h);
      await h.tx.payment.update({
        where: { id: old.paymentId },
        data: { createdAt: new Date(NOW.getTime() - 100 * 3_600_000) },
      });
      deps.clock.now = new Date(NOW.getTime() + 10 * 60_000);
      const d = withStatus(deps, async () => null);
      expect((await reconcilePayments(d, OPTIONS)).checked).toBe(0);
    });
  });
});
