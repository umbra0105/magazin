import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDbClient } from "@ecom/db";
import { earnPoints, expireLot, readBalance, redeemPoints, releasePoints } from "./ledger";

/**
 * Concurența registrului de puncte pe Postgres REAL, cu date comise și conexiuni separate (Faza 15b). Clientul și contul lui
 * de puncte se șterg la final (ștergerea contului ia registrul în cascadă; e singura cale de curățare a datelor de test).
 */
const db = createDbClient({ max: 12 });
const tag = randomUUID().slice(0, 8);
const customers: string[] = [];
const DAY = 86_400_000;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY);

async function customerWith(points: number, expiresAt = inDays(30)): Promise<string> {
  const id = `lc_${tag}_${randomUUID().slice(0, 12)}`;
  await db.user.create({ data: { id, name: "Concurență", email: `${id}@exemplu.test` } });
  customers.push(id);
  await db.$transaction((tx) =>
    earnPoints(tx, {
      customerId: id,
      orderId: `o_${randomUUID()}`,
      points,
      expiresAt,
      now: new Date(),
    }),
  );
  return id;
}

afterAll(async () => {
  await db.loyaltyAccount.deleteMany({ where: { customerId: { in: customers } } });
  await db.user.deleteMany({ where: { id: { in: customers } } });
  await db.$disconnect();
});

const redeem = (customerId: string, points: number, now = new Date()) =>
  db.$transaction((tx) =>
    redeemPoints(tx, { customerId, orderId: `o_${randomUUID()}`, points, now }),
  );

async function invariant(customerId: string): Promise<number> {
  const balance = await readBalance(db, customerId);
  const ledger = await db.loyaltyTransaction.aggregate({
    where: { customerId },
    _sum: { points: true },
  });
  const lots = await db.loyaltyLot.aggregate({ where: { customerId }, _sum: { remaining: true } });
  expect(ledger._sum.points ?? 0).toBe(balance);
  expect(lots._sum.remaining ?? 0).toBe(Math.max(balance, 0));
  return balance;
}

describe("aceleași puncte cerute de mai multe ori deodată", () => {
  it("din 10 puncte, două cereri de câte 10: reușește EXACT una; soldul nu devine negativ", async () => {
    for (let round = 0; round < 12; round += 1) {
      const customerId = await customerWith(10);
      const results = await Promise.allSettled([redeem(customerId, 10), redeem(customerId, 10)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await invariant(customerId)).toBe(0);
    }
  });

  it("8 cereri de câte 3 puncte din 10: reușesc exact 3", async () => {
    const customerId = await customerWith(10);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => redeem(customerId, 3)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await invariant(customerId)).toBe(1);
  });
});

describe("răscumpărare simultană cu expirarea", () => {
  it("lotul e luat o singură dată: ori de comandă, ori de expirare; niciodată de amândouă", async () => {
    for (let round = 0; round < 12; round += 1) {
      // lotul expiră «acum» pentru jobul de expirare, dar pentru comandă ceasul e cu o secundă înainte
      const expiresAt = inDays(1);
      const customerId = await customerWith(10, expiresAt);
      const lot = await db.loyaltyLot.findFirstOrThrow({ where: { customerId } });
      const [redeemed, expired] = await Promise.allSettled([
        redeem(customerId, 10, new Date(expiresAt.getTime() - 1_000)),
        db.$transaction((tx) => expireLot(tx, { lotId: lot.id, now: expiresAt })),
      ]);
      expect(expired.status).toBe("fulfilled");
      const taken = expired.status === "fulfilled" ? expired.value : -1;
      if (redeemed.status === "fulfilled") expect(taken).toBe(0);
      else expect(taken).toBe(10);
      expect(await invariant(customerId)).toBe(0);
    }
  });
});

describe("întoarcerea simultană cu aceeași cheie", () => {
  it("punctele se întorc o singură dată", async () => {
    for (let round = 0; round < 8; round += 1) {
      const customerId = await customerWith(10);
      const orderId = `o_${randomUUID()}`;
      await db.$transaction((tx) =>
        redeemPoints(tx, { customerId, orderId, points: 8, now: new Date() }),
      );
      const release = () =>
        db.$transaction((tx) =>
          releasePoints(tx, {
            customerId,
            orderId,
            points: 8,
            now: new Date(),
            graceDays: 30,
            key: `release:${orderId}:8`,
          }),
        );
      const results = await Promise.all([release(), release(), release()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await invariant(customerId)).toBe(10);
    }
  });
});
