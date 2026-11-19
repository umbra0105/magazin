import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  demoRequest,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../test-utils/payment-fixtures";
import { listPayments, paymentCounters, paymentDetail, stuckPaymentEvents } from "./payment-admin";
import { ingestPaymentWebhook, processPaymentEvent } from "./payment-processor";
import { requestRefund } from "./refund-service";

/** Faza 10, citirile pentru ecranele de plăți: lista cu filtre, detaliul cu cronologie, contoarele de sănătate. */
const db = getDb();
afterAll(() => db.$disconnect());

describe("ecranele de plăți din admin", () => {
  it("lista: «necesită atenție» arată plățile cu motiv activ și cu rambursări deschise; rezolvate dispar", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h, { refundBehavior: "manual_required" });
      const mismatch = await placeCardOrder(h);
      await deliver(deps, paidEvent(mismatch.paymentId, mismatch.amountMinor - 1));
      const fine = await placeCardOrder(h);
      await deliver(deps, paidEvent(fine.paymentId, fine.amountMinor));
      const plain = await placeCardOrder(h);

      const all = await listPayments(h.tx, { view: "all", page: 1, pageSize: 50 });
      const ids = all.rows.map((r) => r.id);
      expect(ids).toEqual(
        expect.arrayContaining([mismatch.paymentId, fine.paymentId, plain.paymentId]),
      );

      const attention = await listPayments(h.tx, { view: "attention", page: 1, pageSize: 50 });
      expect(attention.rows.map((r) => r.id)).toEqual([mismatch.paymentId]);
      expect(attention.rows[0]?.attentionReason).toBe("amount_mismatch");

      // o rambursare manuală deschisă pune plata în aceeași listă
      await requestRefund(
        { db: h.tx, getProvider: deps.getProvider, now: deps.now },
        {
          paymentId: fine.paymentId,
          amountMinor: 500,
          reason: "Test",
          idempotencyKey: "a1",
          actorLabel: "x",
        },
      );
      const again = await listPayments(h.tx, { view: "attention", page: 1, pageSize: 50 });
      expect(again.rows.map((r) => r.id).sort()).toEqual(
        [mismatch.paymentId, fine.paymentId].sort(),
      );
      const refunds = await listPayments(h.tx, { view: "refunds", page: 1, pageSize: 50 });
      expect(refunds.rows.map((r) => r.id)).toEqual([fine.paymentId]);
    });
  });

  it("paginarea respectă pagina și mărimea", async () => {
    await cardHarness(async (h) => {
      for (let i = 0; i < 3; i++) await placeCardOrder(h);
      const first = await listPayments(h.tx, { view: "all", page: 1, pageSize: 5 });
      expect(first.rows.length).toBeLessThanOrEqual(5);
      const huge = await listPayments(h.tx, { view: "all", page: 0, pageSize: 100_000 });
      expect(huge.page).toBe(1);
      expect(huge.pageSize).toBe(100);
    });
  });

  it("detaliul: cronologia comenzii, rambursările, suma rămasă; nimic secret", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const placed = await placeCardOrder(h);
      await deliver(deps, paidEvent(placed.paymentId, placed.amountMinor));
      await requestRefund(
        { db: h.tx, getProvider: deps.getProvider, now: deps.now },
        {
          paymentId: placed.paymentId,
          amountMinor: 1_000,
          reason: "Parțial",
          idempotencyKey: "d1",
          actorLabel: "a@b.ro",
        },
      );
      const detail = await paymentDetail(h.tx, placed.paymentId);
      expect(detail).not.toBeNull();
      expect(detail!.remainingRefundableMinor).toBe(placed.amountMinor - 1_000);
      expect(detail!.refunds).toHaveLength(1);
      expect(detail!.timeline.map((e) => e.type)).toEqual(
        expect.arrayContaining(["order.placed", "payment.confirmed", "payment.refunded"]),
      );
      expect(JSON.stringify(detail)).not.toContain("rawPayload");
      expect(await paymentDetail(h.tx, "nu-exista")).toBeNull();
      const unpaid = await placeCardOrder(h);
      expect((await paymentDetail(h.tx, unpaid.paymentId))!.remainingRefundableMinor).toBe(0);
    });
  });

  it("contoarele: respinse în 24 h, evenimente blocate, rambursări manuale, plăți care cer atenție", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const before = await paymentCounters(h.tx, NOW);
      await ingestPaymentWebhook(deps, "demo", { headers: {}, rawBody: Buffer.from("{}") });
      await ingestPaymentWebhook(deps, "demo", { headers: {}, rawBody: Buffer.from("{ }") });
      // un eveniment valid pentru o plată necunoscută, care epuizează încercările
      const ingest = await ingestPaymentWebhook(
        deps,
        "demo",
        demoRequest(paidEvent("inexistenta", 100)),
      );
      for (let i = 0; i < 6; i++)
        await processPaymentEvent(deps, ingest.eventId!).catch(() => undefined);
      const after = await paymentCounters(h.tx, NOW);
      expect(after.rejectedLast24h).toBe(before.rejectedLast24h + 2);
      expect(after.stuckEvents).toBe(before.stuckEvents + 1);
      expect((await stuckPaymentEvents(h.tx)).some((e) => e.id === ingest.eventId)).toBe(true);
      // evenimentele respinse mai vechi de 24 h nu mai intră în contor
      const later = new Date(NOW.getTime() + 25 * 3_600_000);
      expect((await paymentCounters(h.tx, later)).rejectedLast24h).toBe(0);
    });
  });
});
