import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createUser } from "../test-utils/digital-fixtures";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  adjustPoints,
  earnPoints,
  expireLot,
  readBalance,
  redeemPoints,
  releasePoints,
  revokePoints,
  spendableBalance,
} from "./ledger";

/**
 * Serviciul registrului de puncte (Faza 15b), pe Postgres real, în tranzacție anulată. Ceasul e injectat (`NOW`), iar toate
 * datele pleacă din el. Fără date de seed: clientul se creează aici.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2031-03-10T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);
const order = (): string => `o_${randomUUID()}`;

const run = <T>(fn: (tx: TestTx, customerId: string) => Promise<T>) =>
  inRolledBackTransaction(db, async (tx) => fn(tx, (await createUser(tx)).id));

const earn = (
  tx: TestTx,
  customerId: string,
  points: number,
  expiresInDays: number,
  id = order(),
) => earnPoints(tx, { customerId, orderId: id, points, expiresAt: at(expiresInDays), now: NOW });

const lotsOf = async (tx: TestTx, customerId: string) =>
  (
    await tx.loyaltyLot.findMany({
      where: { customerId },
      orderBy: [{ createdAt: "asc" }, { expiresAt: "asc" }, { id: "asc" }],
    })
  ).map((lot) => ({
    points: lot.points,
    remaining: lot.remaining,
    days: Math.round((lot.expiresAt.getTime() - NOW.getTime()) / DAY),
  }));

/** Regula de aur: soldul = suma registrului; restul loturilor = soldul când e pozitiv, altfel 0. */
async function invariant(tx: TestTx, customerId: string): Promise<number> {
  const balance = await readBalance(tx, customerId);
  const ledger = await tx.loyaltyTransaction.aggregate({
    where: { customerId },
    _sum: { points: true },
  });
  const lots = await tx.loyaltyLot.aggregate({
    where: { customerId },
    _sum: { remaining: true },
  });
  expect(ledger._sum.points ?? 0, "soldul recalculat din registru").toBe(balance);
  expect(lots._sum.remaining ?? 0, "restul loturilor").toBe(Math.max(balance, 0));
  return balance;
}

describe("acumularea", () => {
  it("scrie tranzacția și lotul cu expirare; a doua acumulare pe aceeași comandă nu face nimic", async () => {
    await run(async (tx, customerId) => {
      const id = order();
      expect(await earn(tx, customerId, 7, 365, id)).toBe(true);
      expect(await earn(tx, customerId, 7, 365, id)).toBe(false);
      expect(await lotsOf(tx, customerId)).toEqual([{ points: 7, remaining: 7, days: 365 }]);
      expect(await invariant(tx, customerId)).toBe(7);
    });
  });

  it("0 puncte nu scriu nimic", async () => {
    await run(async (tx, customerId) => {
      expect(await earn(tx, customerId, 0, 365)).toBe(false);
      expect(await tx.loyaltyTransaction.count({ where: { customerId } })).toBe(0);
    });
  });
});

describe("răscumpărarea", () => {
  it("consumă întâi lotul care expiră primul (cel mai vechi)", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 100);
      await earn(tx, customerId, 5, 10);
      await redeemPoints(tx, { customerId, orderId: order(), points: 8, now: NOW });
      expect((await lotsOf(tx, customerId)).sort((a, b) => a.days - b.days)).toEqual([
        { points: 5, remaining: 0, days: 10 },
        { points: 10, remaining: 7, days: 100 },
      ]);
      expect(await invariant(tx, customerId)).toBe(7);
    });
  });

  it("un lot expirat, dar încă nescăzut de job, nu se mai poate cheltui", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, -1);
      await earn(tx, customerId, 5, 30);
      expect(await readBalance(tx, customerId)).toBe(15);
      expect(await spendableBalance(tx, customerId, NOW)).toBe(5);
      await expect(
        redeemPoints(tx, { customerId, orderId: order(), points: 6, now: NOW }),
      ).rejects.toMatchObject({ code: "LOYALTY_INSUFFICIENT_POINTS" });
      await redeemPoints(tx, { customerId, orderId: order(), points: 5, now: NOW });
      expect(await invariant(tx, customerId)).toBe(10);
    });
  });

  it("peste sold: refuz, fără niciun rând scris", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 30);
      await expect(
        redeemPoints(tx, { customerId, orderId: order(), points: 11, now: NOW }),
      ).rejects.toMatchObject({ code: "LOYALTY_INSUFFICIENT_POINTS" });
      expect(await tx.loyaltyTransaction.count({ where: { customerId } })).toBe(1);
      expect(await invariant(tx, customerId)).toBe(10);
    });
  });

  it.each([0, -3, 1.5])("%s puncte sunt refuzate", async (points) => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 30);
      await expect(
        redeemPoints(tx, { customerId, orderId: order(), points, now: NOW }),
      ).rejects.toThrow();
    });
  });
});

describe("întoarcerea punctelor folosite", () => {
  it("se întorc ca puncte, cu data inițială; sub termenul de grație primesc grația", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 5, 5);
      await earn(tx, customerId, 10, 200);
      const id = order();
      await redeemPoints(tx, { customerId, orderId: id, points: 12, now: NOW });
      expect(
        await releasePoints(tx, {
          customerId,
          orderId: id,
          points: 12,
          now: NOW,
          graceDays: 30,
          key: `release:${id}:12`,
        }),
      ).toBe(true);
      const restored = (await lotsOf(tx, customerId)).filter((lot) => lot.remaining > 0);
      expect(restored.sort((a, b) => a.days - b.days)).toEqual([
        // 5 puncte din lotul care expira peste 5 zile: primesc 30 de zile
        { points: 5, remaining: 5, days: 30 },
        // restul lotului de 200 de zile (3) și cele 7 întoarse, cu data inițială
        { points: 10, remaining: 3, days: 200 },
        { points: 7, remaining: 7, days: 200 },
      ]);
      expect(await invariant(tx, customerId)).toBe(15);
    });
  });

  it("un lot deja expirat între timp: punctele întoarse primesc grația, nu dispar imediat", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 20, 3);
      const id = order();
      await redeemPoints(tx, { customerId, orderId: id, points: 20, now: NOW });
      const later = at(60);
      await releasePoints(tx, {
        customerId,
        orderId: id,
        points: 20,
        now: later,
        graceDays: 30,
        key: "k1",
      });
      expect((await lotsOf(tx, customerId)).filter((l) => l.remaining > 0)).toEqual([
        { points: 20, remaining: 20, days: 90 },
      ]);
      expect(await spendableBalance(tx, customerId, later)).toBe(20);
    });
  });

  it("grația 0: data inițială, chiar dacă a trecut", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 20, 3);
      const id = order();
      await redeemPoints(tx, { customerId, orderId: id, points: 20, now: NOW });
      await releasePoints(tx, {
        customerId,
        orderId: id,
        points: 20,
        now: at(60),
        graceDays: 0,
        key: "k0",
      });
      // lotul întors păstrează data lui (ziua 3), deși întoarcerea se face în ziua 60
      expect((await lotsOf(tx, customerId)).filter((l) => l.remaining > 0)[0]?.days).toBe(3);
    });
  });

  it("în bucăți: întâi cele cu valabilitatea cea mai lungă; aceeași cheie nu întoarce de două ori", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 5, 100);
      await earn(tx, customerId, 5, 300);
      const id = order();
      await redeemPoints(tx, { customerId, orderId: id, points: 10, now: NOW });
      const part = { customerId, orderId: id, now: NOW, graceDays: 30 };
      expect(await releasePoints(tx, { ...part, points: 4, key: "a" })).toBe(true);
      expect(await releasePoints(tx, { ...part, points: 4, key: "a" })).toBe(false);
      expect(await releasePoints(tx, { ...part, points: 6, key: "b" })).toBe(true);
      expect(
        (await lotsOf(tx, customerId))
          .filter((l) => l.remaining > 0)
          .map((l) => [l.days, l.remaining])
          .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
      ).toEqual([
        [100, 5],
        [300, 1],
        [300, 4],
      ]);
      expect(await invariant(tx, customerId)).toBe(10);
    });
  });

  it("nu se întorc mai multe puncte decât s-au folosit pe comandă", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 100);
      const id = order();
      await redeemPoints(tx, { customerId, orderId: id, points: 4, now: NOW });
      const part = { customerId, orderId: id, now: NOW, graceDays: 30 };
      await releasePoints(tx, { ...part, points: 3, key: "x" });
      await expect(releasePoints(tx, { ...part, points: 2, key: "y" })).rejects.toMatchObject({
        code: "LOYALTY_RELEASE_INVALID",
      });
      expect(await invariant(tx, customerId)).toBe(9);
    });
  });
});

describe("revocarea și soldul negativ", () => {
  it("ia întâi din lotul comenzii returnate", async () => {
    await run(async (tx, customerId) => {
      const id = order();
      await earn(tx, customerId, 5, 10);
      await earn(tx, customerId, 8, 300, id);
      await revokePoints(tx, { customerId, orderId: id, points: 6, now: NOW, key: "rv1" });
      expect((await lotsOf(tx, customerId)).sort((a, b) => a.days - b.days)).toEqual([
        { points: 5, remaining: 5, days: 10 },
        { points: 8, remaining: 2, days: 300 },
      ]);
      expect(await invariant(tx, customerId)).toBe(7);
    });
  });

  it("după ce punctele au fost cheltuite: sold negativ, folosirea blocată, iar acumularea următoare acoperă datoria", async () => {
    await run(async (tx, customerId) => {
      const first = order();
      await earn(tx, customerId, 10, 300, first);
      await redeemPoints(tx, { customerId, orderId: order(), points: 10, now: NOW });
      await revokePoints(tx, { customerId, orderId: first, points: 4, now: NOW, key: "rv2" });
      expect(await invariant(tx, customerId)).toBe(-4);
      expect(await spendableBalance(tx, customerId, NOW)).toBe(-4);
      await expect(
        redeemPoints(tx, { customerId, orderId: order(), points: 1, now: NOW }),
      ).rejects.toMatchObject({ code: "LOYALTY_INSUFFICIENT_POINTS" });
      await earn(tx, customerId, 10, 300);
      expect(await invariant(tx, customerId)).toBe(6);
      expect(await spendableBalance(tx, customerId, NOW)).toBe(6);
    });
  });

  it("aceeași cheie nu revocă de două ori", async () => {
    await run(async (tx, customerId) => {
      const id = order();
      await earn(tx, customerId, 10, 300, id);
      const input = { customerId, orderId: id, points: 3, now: NOW, key: "rv3" };
      expect(await revokePoints(tx, input)).toBe(true);
      expect(await revokePoints(tx, input)).toBe(false);
      expect(await invariant(tx, customerId)).toBe(7);
    });
  });

  it("punctele întoarse pe un sold negativ acoperă întâi datoria", async () => {
    await run(async (tx, customerId) => {
      const earned = order();
      const used = order();
      await earn(tx, customerId, 10, 300, earned);
      await redeemPoints(tx, { customerId, orderId: used, points: 10, now: NOW });
      await revokePoints(tx, { customerId, orderId: earned, points: 4, now: NOW, key: "rv4" });
      await releasePoints(tx, {
        customerId,
        orderId: used,
        points: 10,
        now: NOW,
        graceDays: 30,
        key: "rel4",
      });
      expect(await invariant(tx, customerId)).toBe(6);
    });
  });
});

describe("expirarea", () => {
  const lotId = async (tx: TestTx, customerId: string) =>
    (await tx.loyaltyLot.findFirstOrThrow({ where: { customerId } })).id;

  it("scade restul lotului expirat, o singură dată", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 30);
      const id = await lotId(tx, customerId);
      expect(await expireLot(tx, { lotId: id, now: at(29) })).toBe(0);
      expect(await expireLot(tx, { lotId: id, now: at(30) })).toBe(10);
      expect(await expireLot(tx, { lotId: id, now: at(31) })).toBe(0);
      expect(await invariant(tx, customerId)).toBe(0);
    });
  });

  it("NU atinge punctele rezervate într-o comandă activă: doar restul necheltuit", async () => {
    await run(async (tx, customerId) => {
      await earn(tx, customerId, 10, 30);
      await redeemPoints(tx, { customerId, orderId: order(), points: 7, now: NOW });
      expect(await expireLot(tx, { lotId: await lotId(tx, customerId), now: at(40) })).toBe(3);
      expect(await invariant(tx, customerId)).toBe(0);
    });
  });
});

describe("ajustarea manuală", () => {
  const base = { reason: "gest comercial", actorId: "u_admin", now: NOW, expiresAt: at(365) };

  it("pozitivă: lot nou; negativă: consumă; motivul și autorul rămân în registru", async () => {
    await run(async (tx, customerId) => {
      expect(await adjustPoints(tx, { ...base, customerId, points: 20, key: "a1" })).toBe(true);
      expect(await adjustPoints(tx, { ...base, customerId, points: -5, key: "a2" })).toBe(true);
      expect(await adjustPoints(tx, { ...base, customerId, points: -5, key: "a2" })).toBe(false);
      expect(await invariant(tx, customerId)).toBe(15);
      const rows = await tx.loyaltyTransaction.findMany({
        where: { customerId },
        orderBy: { seq: "asc" },
      });
      expect(rows.map((r) => [r.type, r.points, r.reason, r.actorId, r.balanceAfter])).toEqual([
        ["adjust", 20, "gest comercial", "u_admin", 20],
        ["adjust", -5, "gest comercial", "u_admin", 15],
      ]);
    });
  });

  it.each([
    ["fără motiv", { reason: "  ", points: 5 }],
    ["zero puncte", { points: 0 }],
    ["mai mult decât soldul", { points: -1 }],
  ])("%s: refuzată", async (_label, over) => {
    await run(async (tx, customerId) => {
      await expect(
        adjustPoints(tx, { ...base, customerId, key: "a3", ...over } as never),
      ).rejects.toThrow();
    });
  });
});

describe("soldul recalculat din registru", () => {
  it("după un șir amestecat de operații dă același rezultat ca soldul păstrat", async () => {
    await run(async (tx, customerId) => {
      const a = order();
      const b = order();
      await earn(tx, customerId, 50, 100, a);
      await redeemPoints(tx, { customerId, orderId: b, points: 30, now: NOW });
      await releasePoints(tx, {
        customerId,
        orderId: b,
        points: 11,
        now: NOW,
        graceDays: 30,
        key: "s1",
      });
      await revokePoints(tx, { customerId, orderId: a, points: 45, now: NOW, key: "s2" });
      await adjustPoints(tx, {
        customerId,
        points: 40,
        reason: "corecție",
        actorId: "u_admin",
        now: NOW,
        expiresAt: at(10),
        key: "s3",
      });
      for (const lot of await tx.loyaltyLot.findMany({ where: { customerId } })) {
        await expireLot(tx, { lotId: lot.id, now: at(20) });
      }
      // 50 − 30 + 11 − 45 + 40 = 26; lotul de ajustare (10 zile) expiră cu restul lui
      await invariant(tx, customerId);
    });
  });
});
