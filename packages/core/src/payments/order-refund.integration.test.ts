import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { codeOf, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
  type TestDeps,
} from "../test-utils/payment-fixtures";
import { requestOrderRefund, type OrderRefundDeps } from "./order-refund";

/**
 * Rambursarea din detaliul comenzii, cu limita rolului Suport (decizia 2026-11-19), pe Postgres real. Regula e pe server, sub
 * blocarea comenzii: limita exactă trece, limita + 1 ban nu; rambursările cu limită se adună pe comandă; setarea lipsă = refuz;
 * actorul cu `payments.refund` nu are limită; o rambursare eșuată nu mai ține din limită.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const LIMIT = 50_000;

async function paidOrder(h: Harness, deps: TestDeps, price = 400_000) {
  const placed = await placeCardOrder(h, { price });
  await deliver(deps, paidEvent(placed.paymentId, placed.amountMinor));
  return placed;
}

function orderDeps(
  h: Harness,
  deps: TestDeps,
  over: { limit?: number | null; refund?: "confirmed" | "failed" | "manual_required" } = {},
): OrderRefundDeps {
  const behavior = over.refund ?? "confirmed";
  const provider = {
    code: deps.provider.code,
    mode: deps.provider.mode,
    createPayment: deps.provider.createPayment.bind(deps.provider),
    verifyWebhook: deps.provider.verifyWebhook.bind(deps.provider),
    capture: deps.provider.capture.bind(deps.provider),
    refund: async () =>
      behavior === "confirmed"
        ? ({ status: "confirmed", providerRef: "r-1" } as const)
        : behavior === "failed"
          ? ({ status: "failed", message: "refuzat" } as const)
          : ({ status: "manual_required", message: "manual" } as const),
    getStatus: deps.provider.getStatus.bind(deps.provider),
    testConnection: deps.provider.testConnection.bind(deps.provider),
  };
  return {
    db: h.tx,
    getProvider: async () => provider,
    now: () => deps.clock.now,
    readLimitMinor: async () => (over.limit === undefined ? LIMIT : over.limit),
  };
}

const ask = (
  orderId: string,
  amountMinor: number,
  key: string,
  over: { unlimited?: boolean; reason?: string } = {},
) => ({
  orderId,
  amountMinor,
  reason: over.reason ?? "Client nemulțumit",
  idempotencyKey: `order:${key}`,
  actorLabel: "suport@exemplu.ro",
  actorUnlimited: over.unlimited ?? false,
});

describe("limita de rambursare a rolului Suport", () => {
  it("LIMITA EXACTĂ trece și marchează rândul ca «actor cu limită»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId } = await paidOrder(h, deps);
      const result = await requestOrderRefund(orderDeps(h, deps), ask(orderId, LIMIT, "a"));
      expect(result.created).toBe(true);
      const refund = await h.tx.refund.findUniqueOrThrow({ where: { id: result.refundId } });
      expect(refund).toMatchObject({
        paymentId,
        amountMinor: LIMIT,
        limitedActor: true,
        kind: "admin",
        status: "confirmed",
      });
    });
  });

  it("limita + 1 ban se refuză, fără niciun efect (nici rând, nici sumă angajată, nici apel la procesator)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId } = await paidOrder(h, deps);
      expect(
        await codeOf(requestOrderRefund(orderDeps(h, deps), ask(orderId, LIMIT + 1, "a"))),
      ).toBe("REFUND_OVER_LIMIT");
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
      expect(
        (await h.tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundCommittedMinor,
      ).toBe(0);
    });
  });

  it("rambursările cu limită se adună pe comandă: 30.000 + 20.000 trece, apoi 1 ban se refuză", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd = orderDeps(h, deps);
      await requestOrderRefund(rd, ask(orderId, 30_000, "a"));
      await requestOrderRefund(rd, ask(orderId, 20_000, "b"));
      const error = await requestOrderRefund(rd, ask(orderId, 1, "c")).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("REFUND_OVER_LIMIT");
      expect((error as { details?: { remainingMinor?: number } }).details?.remainingMinor).toBe(0);
    });
  });

  it("alt actor cu limită pe aceeași comandă nu are o limită proprie: se adună (nu se ocolește cu două conturi)", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd = orderDeps(h, deps);
      await requestOrderRefund(rd, {
        ...ask(orderId, 40_000, "a"),
        actorLabel: "suport1@exemplu.ro",
      });
      expect(
        await codeOf(
          requestOrderRefund(rd, {
            ...ask(orderId, 20_000, "b"),
            actorLabel: "suport2@exemplu.ro",
          }),
        ),
      ).toBe("REFUND_OVER_LIMIT");
    });
  });

  it("rambursarea unui Manager (fără limită) nu consumă din limita Suportului și nu e blocată de ea", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd = orderDeps(h, deps);
      const big = await requestOrderRefund(rd, ask(orderId, 300_000, "m", { unlimited: true }));
      const row = await h.tx.refund.findUniqueOrThrow({ where: { id: big.refundId } });
      expect(row.limitedActor).toBe(false);
      // Suportul are încă toată limita
      await requestOrderRefund(rd, ask(orderId, LIMIT, "s"));
    });
  });

  it("setarea lipsă sau coruptă = refuz pentru actorul cu limită; actorul fără limită trece", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd = orderDeps(h, deps, { limit: null });
      expect(await codeOf(requestOrderRefund(rd, ask(orderId, 1, "a")))).toBe(
        "REFUND_LIMIT_UNAVAILABLE",
      );
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(0);
      await requestOrderRefund(rd, ask(orderId, 1, "b", { unlimited: true }));
    });
  });

  it("o eroare la citirea setării e tratată ca lipsă (refuz), nu ca «fără limită»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd: OrderRefundDeps = {
        ...orderDeps(h, deps),
        readLimitMinor: async () => {
          throw new Error("setarea nu se poate citi");
        },
      };
      expect(await codeOf(requestOrderRefund(rd, ask(orderId, 1, "a")))).toBe(
        "REFUND_LIMIT_UNAVAILABLE",
      );
    });
  });

  it("o rambursare EȘUATĂ nu mai ține din limită (se poate cere din nou); una «manuală necesară» ține", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      await requestOrderRefund(orderDeps(h, deps, { refund: "failed" }), ask(orderId, LIMIT, "a"));
      // eșuată: limita e din nou liberă
      await requestOrderRefund(
        orderDeps(h, deps, { refund: "manual_required" }),
        ask(orderId, LIMIT, "b"),
      );
      // manuală necesară: suma rămâne angajată în limită
      expect(await codeOf(requestOrderRefund(orderDeps(h, deps), ask(orderId, 1, "c")))).toBe(
        "REFUND_OVER_LIMIT",
      );
    });
  });

  it("aceeași cheie de idempotență (dublu-click) nu rambursează de două ori și nu numără de două ori în limită", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      const rd = orderDeps(h, deps);
      const a = await requestOrderRefund(rd, ask(orderId, LIMIT, "same"));
      const b = await requestOrderRefund(rd, ask(orderId, LIMIT, "same"));
      expect(b).toMatchObject({ refundId: a.refundId, created: false });
      expect(await h.tx.refund.count({ where: { orderId } })).toBe(1);
    });
  });

  it("limita 0 = Suportul nu poate rambursa nimic", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      expect(
        await codeOf(requestOrderRefund(orderDeps(h, deps, { limit: 0 }), ask(orderId, 1, "a"))),
      ).toBe("REFUND_OVER_LIMIT");
    });
  });

  it("limita nu scoate plafonul plății: peste ce a rămas din plată se refuză chiar și pentru actorul fără limită", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, amountMinor } = await paidOrder(h, deps);
      expect(
        await codeOf(
          requestOrderRefund(
            orderDeps(h, deps),
            ask(orderId, amountMinor + 1, "a", { unlimited: true }),
          ),
        ),
      ).toBe("REFUND_EXCEEDS_PAID");
    });
  });

  it("comandă fără plată încasată sau inexistentă: refuz clar", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const unpaid = await placeCardOrder(h);
      const rd = orderDeps(h, deps);
      expect(await codeOf(requestOrderRefund(rd, ask(unpaid.orderId, 100, "a")))).toBe(
        "PAYMENT_NOT_REFUNDABLE",
      );
      expect(await codeOf(requestOrderRefund(rd, ask("nu-exista", 100, "b")))).toBe(
        "PAYMENT_NOT_FOUND",
      );
    });
  });

  it("rambursarea trece prin aceeași mașină de stări: paymentStatus devine partially_refunded, comanda nu se atinge", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId } = await paidOrder(h, deps);
      await requestOrderRefund(orderDeps(h, deps), ask(orderId, 10_000, "a"));
      const order = await orderOf(h.tx, orderId);
      expect(order.paymentStatus).toBe("partially_refunded");
      expect(order.status).toBe("confirmed");
    });
  });
});
