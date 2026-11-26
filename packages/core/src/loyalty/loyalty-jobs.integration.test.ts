import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createUser } from "../test-utils/digital-fixtures";
import { enableLoyalty } from "../test-utils/loyalty-fixtures";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { earnPoints, readBalance, redeemPoints } from "./ledger";
import { LOYALTY_WARNING_TEMPLATE, expireDuePoints, sendExpiryWarnings } from "./loyalty-jobs";

/**
 * Joburile de expirare și de avertizare (Faza 15b), pe Postgres real, în tranzacție anulată, cu ceasul INJECTAT: toate datele
 * pleacă din `NOW`. Avertizarea pleacă o singură dată pe lot, prin outbox; expirarea nu atinge punctele rezervate.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2031-05-01T08:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const run = <T>(fn: (tx: TestTx) => Promise<T>, over: Record<string, unknown> = {}) =>
  inRolledBackTransaction(db, async (tx) => {
    await enableLoyalty(tx, over);
    return fn(tx);
  });

async function withLot(tx: TestTx, points: number, expiresInDays: number, userId?: string) {
  const id = userId ?? (await createUser(tx)).id;
  await earnPoints(tx, {
    customerId: id,
    orderId: `o_${randomUUID()}`,
    points,
    expiresAt: at(expiresInDays),
    now: at(-1),
  });
  return id;
}

const warnings = (tx: TestTx) =>
  tx.emailDispatch.findMany({
    where: { template: LOYALTY_WARNING_TEMPLATE },
    orderBy: { createdAt: "asc" },
  });

describe("avertizarea de expirare", () => {
  it("pleacă pentru lotul care expiră în cel mult 30 de zile, o singură dată", async () => {
    await run(async (tx) => {
      const soon = await withLot(tx, 10, 30);
      await withLot(tx, 10, 31);
      const before = (await warnings(tx)).length;
      expect(await sendExpiryWarnings(tx, { now: NOW })).toMatchObject({ queued: 1 });
      expect(await sendExpiryWarnings(tx, { now: NOW })).toMatchObject({ queued: 0 });
      const rows = (await warnings(tx)).slice(before);
      const user = await tx.user.findUniqueOrThrow({ where: { id: soon } });
      const lot = await tx.loyaltyLot.findFirstOrThrow({ where: { customerId: soon } });
      expect(rows.map((r) => [r.recipient, r.orderId, r.audience, r.data])).toEqual([
        [user.email, null, "customer", { lotId: lot.id }],
      ]);
      expect(lot.warnedAt?.toISOString()).toBe(NOW.toISOString());
    });
  });

  it("a doua zi, lotul intrat între timp în fereastră primește și el emailul lui", async () => {
    await run(async (tx) => {
      await withLot(tx, 10, 31);
      expect((await sendExpiryWarnings(tx, { now: NOW })).queued).toBe(0);
      expect((await sendExpiryWarnings(tx, { now: at(1) })).queued).toBe(1);
    });
  });

  it("nu pleacă pentru loturi goale, expirate sau pentru conturi anonimizate", async () => {
    await run(async (tx) => {
      const spent = await withLot(tx, 10, 10);
      await redeemPoints(tx, {
        customerId: spent,
        orderId: `o_${randomUUID()}`,
        points: 10,
        now: NOW,
      });
      await withLot(tx, 10, -1);
      const gone = await withLot(tx, 10, 10);
      await tx.user.update({ where: { id: gone }, data: { anonymizedAt: NOW } });
      expect((await sendExpiryWarnings(tx, { now: NOW })).queued).toBe(0);
    });
  });

  it("numărul de zile vine din setare; cu programul oprit nu pleacă nimic", async () => {
    await run(
      async (tx) => {
        await withLot(tx, 10, 8);
        expect((await sendExpiryWarnings(tx, { now: NOW })).queued).toBe(0);
        expect((await sendExpiryWarnings(tx, { now: at(1) })).queued).toBe(1);
      },
      { expiryWarningDays: 7 },
    );
    await run(
      async (tx) => {
        await withLot(tx, 10, 5);
        expect((await sendExpiryWarnings(tx, { now: NOW })).queued).toBe(0);
      },
      { enabled: false },
    );
  });
});

describe("jobul de expirare", () => {
  it("expiră doar restul loturilor ajunse la termen, o singură dată", async () => {
    await run(async (tx) => {
      const id = await withLot(tx, 10, 5);
      await withLot(tx, 7, 40, id);
      expect(await expireDuePoints(tx, { now: at(4) })).toMatchObject({ lots: 0, points: 0 });
      expect(await expireDuePoints(tx, { now: at(5) })).toMatchObject({ lots: 1, points: 10 });
      expect(await expireDuePoints(tx, { now: at(6) })).toMatchObject({ lots: 0 });
      expect(await readBalance(tx, id)).toBe(7);
    });
  });

  it("punctele rezervate într-o comandă activă nu expiră", async () => {
    await run(async (tx) => {
      const id = await withLot(tx, 10, 5);
      await redeemPoints(tx, { customerId: id, orderId: `o_${randomUUID()}`, points: 8, now: NOW });
      expect(await expireDuePoints(tx, { now: at(30) })).toMatchObject({ lots: 1, points: 2 });
      expect(await tx.loyaltyTransaction.count({ where: { customerId: id, type: "redeem" } })).toBe(
        1,
      );
      expect(await readBalance(tx, id)).toBe(0);
    });
  });

  it("cu programul oprit nu expiră nimic", async () => {
    await run(
      async (tx) => {
        const id = await withLot(tx, 10, -5);
        expect(await expireDuePoints(tx, { now: NOW })).toMatchObject({ lots: 0 });
        expect(await readBalance(tx, id)).toBe(10);
      },
      { enabled: false },
    );
  });
});
