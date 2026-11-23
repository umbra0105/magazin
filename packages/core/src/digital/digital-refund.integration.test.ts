import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { PaymentProvider } from "@ecom/shared";
import { transitionOrder } from "../orders/order-service";
import type { OrderRefundDeps } from "../payments/order-refund";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { digitalFixture } from "../test-utils/digital-fixtures";
import { refundDigitalLine } from "./digital-refund";

/**
 * Faza 14b, «Rambursează linia digitală»: banii liniei se întorc prin serviciul de rambursări din Faza 10 (cheia de idempotență
 * poartă linia), accesul la ACEA linie se retrage imediat, celelalte linii rămân neatinse, iar apăsarea repetată nu face nimic în plus.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date(Date.now() + 5_000);

function provider(behavior: "confirmed" | "failed"): PaymentProvider {
  return {
    code: "demo",
    mode: "demo",
    async refund() {
      return behavior === "confirmed"
        ? ({ status: "confirmed", providerRef: "r-1" } as const)
        : ({ status: "failed", message: "refuzat" } as const);
    },
  } as unknown as PaymentProvider;
}

const refundDeps = (
  tx: TestTx,
  behavior: "confirmed" | "failed" = "confirmed",
  limit: number | null = 1_000_000,
): OrderRefundDeps => ({
  db: tx,
  getProvider: async () => provider(behavior),
  now: () => NOW,
  readLimitMinor: async () => limit,
});

async function paidTwoLines(tx: TestTx) {
  const f = await digitalFixture(tx, { digitalLines: 2 });
  await transitionOrder(
    tx,
    f.orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "plătită" },
    NOW,
  );
  await tx.payment.create({
    data: {
      orderId: f.orderId,
      provider: "demo",
      method: "card",
      amountMinor: 20_000,
      status: "paid",
      providerRef: `ref-${f.orderNumber}`,
      capturedAt: NOW,
      capturedAmountMinor: 20_000,
      capturedCurrency: "RON",
      attemptNo: 1,
      mode: "demo",
    },
  });
  const rows = await tx.digitalEntitlement.findMany({
    where: { orderId: f.orderId },
    orderBy: { createdAt: "asc" },
  });
  const byLine = new Map(rows.map((r) => [r.orderLineId, r]));
  return {
    f,
    first: byLine.get(f.digitalLineIds[0] as string)!,
    second: byLine.get(f.digitalLineIds[1] as string)!,
  };
}

const input = (entitlementId: string, unlimited = true) => ({
  entitlementId,
  reason: "Clientul a cerut banii înapoi",
  actorLabel: "admin@exemplu.test",
  actorUnlimited: unlimited,
});

describe("refundDigitalLine", () => {
  it("rambursează suma liniei, retrage accesul DOAR la acea linie și scrie evenimentul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, first, second } = await paidTwoLines(tx);
      const result = await refundDigitalLine(refundDeps(tx), input(first.id), NOW);
      expect(result).toMatchObject({ created: true, amountMinor: 10_000 });

      const refund = await tx.refund.findUniqueOrThrow({ where: { id: result.refundId } });
      expect(refund).toMatchObject({
        amountMinor: 10_000,
        status: "confirmed",
        idempotencyKey: `digital-line:${f.digitalLineIds[0]}`,
      });
      const a = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: first.id } });
      const b = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: second.id } });
      expect(a.revokedAt).not.toBeNull();
      // cu rambursarea confirmată pe loc, cârligul din comandă a retras deja dreptul; retragerea de după nu mai schimbă nimic
      expect(a.revokedReason).toBe("Linia a fost rambursată");
      expect(b.revokedAt).toBeNull();
      const events = await tx.orderEvent.count({
        where: { orderId: f.orderId, type: "digital.revoked" },
      });
      expect(events).toBe(1);
    });
  });

  it("apăsarea repetată întoarce aceeași rambursare, fără alt efect (idempotent)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, first } = await paidTwoLines(tx);
      const one = await refundDigitalLine(refundDeps(tx), input(first.id), NOW);
      const two = await refundDigitalLine(refundDeps(tx), input(first.id), NOW);
      expect(two.refundId).toBe(one.refundId);
      expect(two.created).toBe(false);
      expect(await tx.refund.count({ where: { orderId: f.orderId } })).toBe(1);
      expect(
        await tx.orderEvent.count({ where: { orderId: f.orderId, type: "digital.revoked" } }),
      ).toBe(1);
    });
  });

  it("limita rolului Suport se aplică: peste limită, rambursarea e refuzată și accesul rămâne", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { first } = await paidTwoLines(tx);
      await expect(
        refundDigitalLine(refundDeps(tx, "confirmed", 5_000), input(first.id, false), NOW),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(REFUND|PAYMENT)_/) as unknown as string,
      });
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: first.id } })).revokedAt,
      ).toBeNull();
    });
  });

  it("motiv prea scurt sau drept inexistent: refuzat, nimic nu se schimbă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { first } = await paidTwoLines(tx);
      await expect(
        refundDigitalLine(refundDeps(tx), { ...input(first.id), reason: "ab" }, NOW),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      await expect(
        refundDigitalLine(refundDeps(tx), input("nu-exista"), NOW),
      ).rejects.toMatchObject({ code: "DIGITAL_NOT_FOUND" });
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: first.id } })).revokedAt,
      ).toBeNull();
    });
  });
});
