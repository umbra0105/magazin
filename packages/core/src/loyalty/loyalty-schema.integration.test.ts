import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 15b, schema punctelor de loialitate, pe Postgres real. Fiecare constrângere are un test care o încalcă, iar CHECK-urile
 * compuse au și cazul «una setată, una nulă» (un CHECK cu rezultat NULL TRECE). O instrucțiune refuzată anulează tranzacția
 * Postgres, de aceea fiecare refuz e ULTIMA operație a tranzacției lui. Fără date de seed: totul se creează aici.
 *
 * Pentru cele trei CHECK-uri ÎNLOCUITE (decizia utilizatorului, 2026-11-26: două pe `invoice_line` și unul pe
 * `return_request`) există dovada că regula nouă e o EXTINDERE: pe toate combinațiile de valori, tot ce trecea de regula veche
 * trece și de cea nouă, iar cazurile noi sunt EXACT cele autorizate.
 */
const db = getDb();
afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const inDays = (days: number): Date => new Date(Date.now() + days * 86_400_000);

const rejects = async (fn: (tx: TestTx) => Promise<unknown>, pattern?: RegExp): Promise<void> => {
  const run = inRolledBackTransaction(db, async (tx) => {
    await fn(tx);
  });
  if (pattern) await expect(run).rejects.toThrow(pattern);
  else await expect(run).rejects.toThrow();
};

const accepts = (fn: (tx: TestTx) => Promise<unknown>) =>
  inRolledBackTransaction(db, async (tx) => {
    await fn(tx);
  });

async function makeUser(tx: TestTx): Promise<string> {
  const user = await tx.user.create({
    data: { id: `u_${uid()}${uid()}`, name: "Client", email: `l-${uid()}${uid()}@exemplu.test` },
  });
  return user.id;
}

async function makeAccount(tx: TestTx): Promise<string> {
  const customerId = await makeUser(tx);
  await tx.loyaltyAccount.create({ data: { customerId } });
  return customerId;
}

interface TxExtra {
  orderId?: string | null;
  reason?: string | null;
  actorId?: string | null;
  key?: string;
  balanceAfter?: number;
}

/** O tranzacție de registru; pentru tipurile de comandă primește un `orderId` implicit. */
function entry(tx: TestTx, customerId: string, type: string, points: number, extra: TxExtra = {}) {
  const ofOrder = ["earn", "redeem", "release", "revoke"].includes(type);
  const adjust = type === "adjust";
  return tx.loyaltyTransaction.create({
    data: {
      customerId,
      type,
      points,
      orderId:
        extra.orderId === undefined ? (ofOrder ? `o_${uid()}${uid()}` : null) : extra.orderId,
      reason: extra.reason === undefined ? (adjust ? "gest comercial" : null) : extra.reason,
      actorId: extra.actorId === undefined ? (adjust ? "u_admin" : null) : extra.actorId,
      idempotencyKey: extra.key ?? randomUUID(),
      ...(extra.balanceAfter !== undefined ? { balanceAfter: extra.balanceAfter } : {}),
    },
  });
}

const balanceOf = async (tx: TestTx, customerId: string) =>
  (await tx.loyaltyAccount.findUniqueOrThrow({ where: { customerId } })).balance;

async function makeLot(tx: TestTx, customerId: string, points = 10) {
  const earn = await entry(tx, customerId, "earn", points);
  const lot = await tx.loyaltyLot.create({
    data: { transactionId: earn.id, customerId, points, remaining: points, expiresAt: inDays(365) },
  });
  return { earn, lot };
}

describe("contul de puncte", () => {
  it("pornește de la 0 și nu poate fi creat cu alt sold", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      expect(await balanceOf(tx, customerId)).toBe(0);
    });
    await rejects(async (tx) => {
      await tx.loyaltyAccount.create({ data: { customerId: await makeUser(tx), balance: 5 } });
    }, /loyalty_account/);
  });

  it("soldul NU se editează direct", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await tx.loyaltyAccount.update({ where: { customerId }, data: { balance: 100 } });
    }, /loyalty_account/);
  });

  it("soldul NU se editează nici prin SQL direct, nici ca incrementare", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await tx.$executeRaw`UPDATE loyalty_account SET balance = balance + 7 WHERE "customerId" = ${customerId}`;
    }, /loyalty_account/);
  });
});

describe("registrul: soldul vine din tranzacții", () => {
  it("fiecare tranzacție mișcă soldul, iar `balanceAfter` îl calculează baza (valoarea trimisă se ignoră)", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      const a = await entry(tx, customerId, "earn", 50, { balanceAfter: 999 });
      const b = await entry(tx, customerId, "redeem", -20);
      expect([a.balanceAfter, b.balanceAfter]).toEqual([50, 30]);
      expect(await balanceOf(tx, customerId)).toBe(30);
      const sum = await tx.loyaltyTransaction.aggregate({
        where: { customerId },
        _sum: { points: true },
      });
      expect(sum._sum.points).toBe(30);
    });
  });

  it("o răscumpărare NU poate duce soldul sub 0", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      await entry(tx, customerId, "redeem", -11);
    }, /loyalty_balance_negative/);
  });

  it("o răscumpărare de tot soldul e permisă (ajunge la 0)", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      expect((await entry(tx, customerId, "redeem", -10)).balanceAfter).toBe(0);
    });
  });

  it("revocarea (retur după cheltuire) poate duce soldul sub 0, dar după ea nu se mai răscumpără nimic", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      await entry(tx, customerId, "redeem", -10);
      expect((await entry(tx, customerId, "revoke", -4)).balanceAfter).toBe(-4);
    });
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "revoke", -4);
      await entry(tx, customerId, "redeem", -1);
    }, /loyalty_balance_negative/);
  });

  it.each([
    ["expire", -3],
    ["adjust", -3],
  ])("«%s» nu poate duce soldul sub 0", async (type, points) => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 2);
      await entry(tx, customerId, type, points);
    }, /loyalty_balance_negative/);
  });

  it("o ajustare pozitivă pe un sold negativ e permisă", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "revoke", -4);
      expect((await entry(tx, customerId, "adjust", 3)).balanceAfter).toBe(-1);
    });
  });

  it("fără cont de puncte nu există tranzacție", async () => {
    await rejects(async (tx) => {
      await entry(tx, await makeUser(tx), "earn", 1);
    });
  });
});

describe("registrul: tipuri, semne și câmpuri", () => {
  it("tip necunoscut", async () => {
    await rejects(async (tx) => entry(tx, await makeAccount(tx), "bonus", 1, { orderId: "o_x" }));
  });

  it.each([
    ["earn", -1],
    ["earn", 0],
    ["release", -1],
    ["adjust", 0],
  ])("«%s» cu %i puncte e refuzat", async (type, points) => {
    await rejects(async (tx) => entry(tx, await makeAccount(tx), type, points));
  });

  it.each(["redeem", "expire", "revoke"])("«%s» pozitiv e refuzat", async (type) => {
    await rejects(async (tx) => entry(tx, await makeAccount(tx), type, 1));
  });

  it.each(["earn", "redeem", "release", "revoke"])("«%s» cere comanda", async (type) => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      await entry(tx, customerId, type, type === "redeem" || type === "revoke" ? -1 : 1, {
        orderId: null,
      });
    });
  });

  it.each([
    ["expire", -1],
    ["adjust", 1],
  ])("«%s» nu are comandă", async (type, points) => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      await entry(tx, customerId, type, points, { orderId: "o_x" });
    });
  });

  it.each([
    ["motiv fără autor", { actorId: null }],
    ["autor fără motiv", { reason: null }],
    ["motiv gol", { reason: "   " }],
  ])("ajustarea manuală cere motiv ȘI autor (%s)", async (_label, extra) => {
    await rejects(async (tx) => entry(tx, await makeAccount(tx), "adjust", 5, extra));
  });

  it("doar ajustarea are autor", async () => {
    await rejects(async (tx) => entry(tx, await makeAccount(tx), "earn", 5, { actorId: "u_a" }));
  });

  it("o singură răscumpărare pe comandă", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      await entry(tx, customerId, "redeem", -1, { orderId: "o_unic_r" });
      await entry(tx, customerId, "redeem", -1, { orderId: "o_unic_r" });
    });
  });

  it("o singură acumulare pe comandă", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 1, { orderId: "o_unic_e" });
      await entry(tx, customerId, "earn", 1, { orderId: "o_unic_e" });
    });
  });

  it("mai multe întoarceri și revocări pe aceeași comandă sunt permise (retururi parțiale)", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "release", 1, { orderId: "o_multe" });
      await entry(tx, customerId, "release", 1, { orderId: "o_multe" });
      await entry(tx, customerId, "revoke", -1, { orderId: "o_multe" });
      await entry(tx, customerId, "revoke", -1, { orderId: "o_multe" });
    });
  });

  it("cheia de idempotență e unică, iar tranzacția refuzată NU mișcă soldul", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 5, { key: "cheie-15b" });
      await entry(tx, customerId, "earn", 5, { key: "cheie-15b" });
    });
  });
});

describe("registrul e imuabil", () => {
  it("un rând nu se modifică", async () => {
    await rejects(async (tx) => {
      const row = await entry(tx, await makeAccount(tx), "earn", 5);
      await tx.loyaltyTransaction.update({ where: { id: row.id }, data: { points: 500 } });
    }, /loyalty_ledger/);
  });

  it("un rând nu se șterge", async () => {
    await rejects(async (tx) => {
      const row = await entry(tx, await makeAccount(tx), "earn", 5);
      await tx.loyaltyTransaction.delete({ where: { id: row.id } });
    }, /loyalty_ledger/);
  });

  it("curățarea datelor de test: ștergerea contului ia cu ea registrul, loturile și consumurile", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      const { lot } = await makeLot(tx, customerId);
      const redeem = await entry(tx, customerId, "redeem", -3);
      await tx.loyaltyLotEntry.create({
        data: { transactionId: redeem.id, lotId: lot.id, points: -3 },
      });
      await tx.loyaltyAccount.delete({ where: { customerId } });
      expect(await tx.loyaltyTransaction.count({ where: { customerId } })).toBe(0);
      expect(await tx.loyaltyLot.count({ where: { customerId } })).toBe(0);
    });
  });
});

describe("loturile", () => {
  it("consumul scade restul lotului", async () => {
    await accepts(async (tx) => {
      const customerId = await makeAccount(tx);
      const { lot } = await makeLot(tx, customerId, 10);
      const redeem = await entry(tx, customerId, "redeem", -4);
      await tx.loyaltyLotEntry.create({
        data: { transactionId: redeem.id, lotId: lot.id, points: -4 },
      });
      expect((await tx.loyaltyLot.findUniqueOrThrow({ where: { id: lot.id } })).remaining).toBe(6);
    });
  });

  it("nu se consumă peste restul lotului", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      const { lot } = await makeLot(tx, customerId, 10);
      await makeLot(tx, customerId, 10);
      const redeem = await entry(tx, customerId, "redeem", -11);
      await tx.loyaltyLotEntry.create({
        data: { transactionId: redeem.id, lotId: lot.id, points: -11 },
      });
    }, /loyalty_lot_remaining_check/);
  });

  it("restul lotului NU se scrie direct", async () => {
    await rejects(async (tx) => {
      const { lot } = await makeLot(tx, await makeAccount(tx));
      await tx.loyaltyLot.update({ where: { id: lot.id }, data: { remaining: 1 } });
    }, /loyalty_lot/);
  });

  it("data de expirare a lotului nu se schimbă", async () => {
    await rejects(async (tx) => {
      const { lot } = await makeLot(tx, await makeAccount(tx));
      await tx.loyaltyLot.update({ where: { id: lot.id }, data: { expiresAt: inDays(900) } });
    }, /loyalty_lot/);
  });

  it("marcajul avertizării se poate scrie", async () => {
    await accepts(async (tx) => {
      const { lot } = await makeLot(tx, await makeAccount(tx));
      await tx.loyaltyLot.update({ where: { id: lot.id }, data: { warnedAt: new Date() } });
    });
  });

  it("un lot nu se șterge direct", async () => {
    await rejects(async (tx) => {
      const { lot } = await makeLot(tx, await makeAccount(tx));
      await tx.loyaltyLot.delete({ where: { id: lot.id } });
    }, /loyalty_lot/);
  });

  it("un lot nou are restul egal cu punctele", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      const earn = await entry(tx, customerId, "earn", 10);
      await tx.loyaltyLot.create({
        data: {
          transactionId: earn.id,
          customerId,
          points: 10,
          remaining: 3,
          expiresAt: inDays(1),
        },
      });
    }, /loyalty_lot/);
  });

  it("loturile unei tranzacții nu depășesc punctele ei", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      const { earn } = await makeLot(tx, customerId, 10);
      await tx.loyaltyLot.create({
        data: { transactionId: earn.id, customerId, points: 1, remaining: 1, expiresAt: inDays(1) },
      });
    }, /loyalty_lot/);
  });

  it("o răscumpărare nu poate naște un lot", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      await entry(tx, customerId, "earn", 10);
      const redeem = await entry(tx, customerId, "redeem", -5);
      await tx.loyaltyLot.create({
        data: {
          transactionId: redeem.id,
          customerId,
          points: 5,
          remaining: 5,
          expiresAt: inDays(1),
        },
      });
    }, /loyalty_lot/);
  });

  it("lotul și consumul sunt ale aceluiași client ca tranzacția", async () => {
    await rejects(async (tx) => {
      const mine = await makeAccount(tx);
      const other = await makeAccount(tx);
      const { lot } = await makeLot(tx, other);
      await entry(tx, mine, "earn", 10);
      const redeem = await entry(tx, mine, "redeem", -1);
      await tx.loyaltyLotEntry.create({
        data: { transactionId: redeem.id, lotId: lot.id, points: -1 },
      });
    }, /loyalty_lot/);
  });

  it("consumul e mereu negativ", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      const { lot, earn } = await makeLot(tx, customerId);
      await tx.loyaltyLotEntry.create({
        data: { transactionId: earn.id, lotId: lot.id, points: 1 },
      });
    });
  });

  it("consumul e imuabil", async () => {
    await rejects(async (tx) => {
      const customerId = await makeAccount(tx);
      const { lot } = await makeLot(tx, customerId);
      const redeem = await entry(tx, customerId, "redeem", -2);
      const row = await tx.loyaltyLotEntry.create({
        data: { transactionId: redeem.id, lotId: lot.id, points: -2 },
      });
      await tx.loyaltyLotEntry.delete({ where: { id: row.id } });
    }, /loyalty_ledger/);
  });
});

// ------------------------------------------------------------------------------------------------------------- comanda

async function makeOrder(tx: TestTx, extra: Record<string, unknown> = {}) {
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  const subtotal = (extra["subtotalMinor"] as number | undefined) ?? 10_000;
  const discount = (extra["discountMinor"] as number | undefined) ?? 0;
  const shipping = (extra["shippingMinor"] as number | undefined) ?? 0;
  return tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: `c-${uid()}@exemplu.test`,
      phone: "0722000000",
      subtotalMinor: subtotal,
      discountMinor: discount,
      shippingMinor: shipping,
      taxMinor: 0,
      totalMinor: subtotal - discount + shipping,
      taxRateBps: 2100,
      shippingMethodCode: "courier",
      shippingSnapshot: {},
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      ...extra,
    } as never,
  });
}

const POINTS = {
  discountMinor: 3_000,
  loyaltyPointsUsed: 30,
  loyaltyPointValueMinor: 100,
  loyaltyVatMode: "base_reduced",
  loyaltyCustomerId: "u_client",
};

describe("comanda: punctele folosite", () => {
  it("implicit: zero puncte, nimic altceva", async () => {
    await accepts(async (tx) => {
      expect(await makeOrder(tx)).toMatchObject({
        loyaltyPointsUsed: 0,
        loyaltyPointValueMinor: null,
        loyaltyVatMode: null,
        loyaltyCustomerId: null,
        loyaltyEarnRateMinor: null,
        loyaltyPointsToEarn: null,
        loyaltyEarnDueAt: null,
        loyaltyGrantedAt: null,
      });
    });
  });

  it("o comandă cu puncte completă e acceptată", async () => {
    await accepts((tx) => makeOrder(tx, POINTS));
  });

  it.each([
    ["fără valoarea punctului", { loyaltyPointValueMinor: null }],
    ["fără tratamentul TVA", { loyaltyVatMode: null }],
    ["cu `base_full` (amânat)", { loyaltyVatMode: "base_full" }],
    ["fără client", { loyaltyCustomerId: null }],
    ["cu valoarea punctului 0", { loyaltyPointValueMinor: 0 }],
    ["cu reducerea mai mică decât punctele", { discountMinor: 2_999 }],
    ["cu puncte negative", { loyaltyPointsUsed: -1 }],
  ])("puncte folosite %s: refuzat", async (_label, over) => {
    await rejects(
      (tx) => makeOrder(tx, { ...POINTS, ...over }),
      /customer_order_loyalty_used_check/,
    );
  });

  it.each([
    ["doar valoarea punctului", { loyaltyPointValueMinor: 100 }],
    ["doar tratamentul TVA", { loyaltyVatMode: "base_reduced" }],
  ])("fără puncte, dar %s: refuzat (una setată, una nulă)", async (_label, over) => {
    await rejects((tx) => makeOrder(tx, over), /customer_order_loyalty_used_check/);
  });

  it("reducerea nu depășește produsele: punctele nu ating transportul", async () => {
    await rejects(
      (tx) =>
        makeOrder(tx, {
          ...POINTS,
          subtotalMinor: 10_000,
          shippingMinor: 2_000,
          discountMinor: 10_100,
          loyaltyPointsUsed: 101,
        }),
      /customer_order_loyalty_used_check/,
    );
  });

  it("comanda de 0 lei nu poate exista nici cu puncte", async () => {
    await rejects(
      (tx) => makeOrder(tx, { ...POINTS, discountMinor: 10_000, loyaltyPointsUsed: 100 }),
      /customer_order_amounts_check/,
    );
  });

  it.each([
    ["loyaltyPointsUsed", 31],
    ["loyaltyPointValueMinor", 50],
    ["loyaltyCustomerId", "u_altul"],
    ["loyaltyEarnRateMinor", 5],
    ["loyaltyPointsToEarn", 5],
  ])("instantaneul `%s` e imuabil", async (column, value) => {
    await rejects(async (tx) => {
      const order = await makeOrder(tx, {
        ...POINTS,
        loyaltyEarnRateMinor: 10_000,
        loyaltyPointsToEarn: 0,
      });
      await tx.order.update({ where: { id: order.id }, data: { [column]: value } });
    }, /instantaneul punctelor/);
  });
});

describe("comanda: punctele de primit", () => {
  const EARN = {
    loyaltyCustomerId: "u_client",
    loyaltyEarnRateMinor: 10_000,
    loyaltyPointsToEarn: 1,
  };

  it("acceptate cu rată, puncte și client; data acordării și acordarea se scriu după plasare", async () => {
    await accepts(async (tx) => {
      const order = await makeOrder(tx, EARN);
      await tx.order.update({ where: { id: order.id }, data: { loyaltyEarnDueAt: inDays(14) } });
      await tx.order.update({ where: { id: order.id }, data: { loyaltyGrantedAt: new Date() } });
    });
  });

  it.each([
    ["rata fără puncte", { loyaltyPointsToEarn: null }],
    ["punctele fără rată", { loyaltyEarnRateMinor: null }],
    ["fără client", { loyaltyCustomerId: null }],
    ["rata 0", { loyaltyEarnRateMinor: 0 }],
    ["puncte negative", { loyaltyPointsToEarn: -1 }],
    ["acordare fără dată de la care", { loyaltyGrantedAt: new Date() }],
  ])("%s: refuzat", async (_label, over) => {
    await rejects((tx) => makeOrder(tx, { ...EARN, ...over }), /customer_order_loyalty_earn_check/);
  });

  it("o dată de acordare pe o comandă care nu aduce puncte: refuzată (una setată, una nulă)", async () => {
    await rejects(
      (tx) => makeOrder(tx, { loyaltyEarnDueAt: inDays(1) }),
      /customer_order_loyalty_earn_check/,
    );
  });
});

describe("linia de comandă și linia de retur", () => {
  const line = (orderId: string, over: Record<string, unknown> = {}) => ({
    data: {
      orderId,
      sku: `S-${uid()}`,
      title: "Produs",
      quantity: 10_000n,
      unitSymbol: "buc",
      unitDecimals: 0,
      unitPriceMinor: 10_000,
      lineTotalMinor: 10_000,
      netMinor: 8_264,
      taxMinor: 1_736,
      taxRateBps: 2100,
      stockState: "in_stock",
      shippingClass: "standard",
      productSnapshot: {},
      ...over,
    } as never,
  });

  it("partea de reducere din puncte e între 0 și valoarea liniei", async () => {
    await accepts(async (tx) => {
      const order = await makeOrder(tx);
      const row = await tx.orderLine.create(line(order.id, { loyaltyDiscountMinor: 10_000 }));
      expect(row.loyaltyEarnEligible).toBe(true);
    });
    await rejects(async (tx) => {
      const order = await makeOrder(tx);
      await tx.orderLine.create(line(order.id, { loyaltyDiscountMinor: 10_001 }));
    }, /order_line_loyalty_check/);
    await rejects(async (tx) => {
      const order = await makeOrder(tx);
      await tx.orderLine.create(line(order.id, { loyaltyDiscountMinor: -1 }));
    }, /order_line_loyalty_check/);
  });

  it.each([
    ["loyaltyDiscountMinor", 1],
    ["loyaltyEarnEligible", false],
  ])("`%s` de pe linie e imuabil", async (column, value) => {
    await rejects(async (tx) => {
      const order = await makeOrder(tx);
      const row = await tx.orderLine.create(line(order.id));
      await tx.orderLine.update({ where: { id: row.id }, data: { [column]: value } });
    }, /instantaneul punctelor/);
  });
});

// -------------------------------------------------------------------------------- CHECK-urile ÎNLOCUITE sunt EXTINDERI

/** Textul expresiei unei constrângeri din bază, fără cuvântul `CHECK`. */
async function checkExpression(tx: TestTx, name: string): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ def: string; validated: boolean }[]>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint WHERE conname = '${name}'`,
  );
  expect(rows, name).toHaveLength(1);
  // o constrângere adăugată fără NOT VALID e verificată pe TOATE rândurile existente
  expect(rows[0]!.validated, `${name} validată pe rândurile existente`).toBe(true);
  return rows[0]!.def.replace(/^CHECK\s+/, "");
}

/** Rândurile din grilă care trec de `expression` (o expresie FALSĂ respinge; NULL ar trece, ca la un CHECK). */
async function passing(tx: TestTx, grid: string, expression: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<{ row: string }[]>(
    `SELECT t::text AS row FROM (${grid}) AS t WHERE COALESCE((${expression}), true) ORDER BY 1`,
  );
  return rows.map((r) => r.row);
}

const nullable = (values: string[], type: string) =>
  `(VALUES ${["NULL", ...values].map((v) => `(${v}::${type})`).join(", ")})`;

describe("CHECK-urile înlocuite sunt doar extinderi", () => {
  const KINDS = `(VALUES ('product'), ('shipping'), ('cod_fee'), ('discount'), ('altceva'))`;
  const INVOICE_GRID = `SELECT k.v AS "kind", o.v AS "orderLineId", s.v AS "sku"
    FROM ${KINDS} AS k(v), ${nullable(["'linie'"], "text")} AS o(v), ${nullable(["'SKU'"], "text")} AS s(v)`;

  it("invoice_line_kind_check: singurul tip nou e «discount»", async () => {
    await accepts(async (tx) => {
      const now = await passing(
        tx,
        INVOICE_GRID,
        await checkExpression(tx, "invoice_line_kind_check"),
      );
      const before = await passing(
        tx,
        INVOICE_GRID,
        `"kind" IN ('product', 'shipping', 'cod_fee')`,
      );
      expect(before.filter((r) => !now.includes(r))).toEqual([]);
      const added = now.filter((r) => !before.includes(r));
      expect(added.length).toBe(4);
      expect(added.every((r) => r.startsWith("(discount,"))).toBe(true);
    });
  });

  it("invoice_line_source_check: singurul caz nou e reducerea legată de o linie, fără SKU", async () => {
    await accepts(async (tx) => {
      const old = `("kind" = 'product' AND "orderLineId" IS NOT NULL AND "sku" IS NOT NULL)
        OR ("kind" IN ('shipping', 'cod_fee') AND "orderLineId" IS NULL AND "sku" IS NULL)`;
      const now = await passing(
        tx,
        INVOICE_GRID,
        await checkExpression(tx, "invoice_line_source_check"),
      );
      const before = await passing(tx, INVOICE_GRID, old);
      expect(before.filter((r) => !now.includes(r))).toEqual([]);
      expect(now.filter((r) => !before.includes(r))).toEqual(["(discount,linie,)"]);
    });
  });

  it("return_request_refunded_ck: singurul caz nou e închiderea fără rambursare, cu 0 lei pe produse ȘI pe transport", async () => {
    await accepts(async (tx) => {
      const grid = `SELECT st.v AS "status", id.v AS "refundId", at.v AS "refundedAt", p.v AS "refundProductsMinor",
          s.v AS "refundShippingMinor"
        FROM (VALUES ('inspected'), ('refunded')) AS st(v), ${nullable(["'r1'"], "text")} AS id(v),
          ${nullable(["now()"], "timestamp")} AS at(v), ${nullable(["0", "1"], "int")} AS p(v),
          (VALUES (0), (1)) AS s(v)`;
      const old = `"status" <> 'refunded' OR ("refundId" IS NOT NULL AND "refundedAt" IS NOT NULL)`;
      const now = await passing(tx, grid, await checkExpression(tx, "return_request_refunded_ck"));
      const before = await passing(tx, grid, old);
      expect(before.filter((r) => !now.includes(r))).toEqual([]);
      const added = now.filter((r) => !before.includes(r));
      expect(added).toHaveLength(1);
      // (status, refundId = NULL, refundedAt = completat, produse = 0, transport = 0)
      expect(added[0]).toMatch(/^\(refunded,,"[^"]+",0,0\)$/);
    });
  });
});

describe("returul închis fără rambursare, pe tabela reală", () => {
  async function makeReturn(tx: TestTx) {
    const order = await makeOrder(tx);
    const userId = await makeUser(tx);
    const row = await tx.returnRequest.create({
      data: { orderId: order.id, userId, clientKey: randomUUID() },
    });
    // drumul permis de tranziții: requested → approved → awaiting_shipment → received → inspected
    for (const status of ["approved", "awaiting_shipment", "received", "inspected"]) {
      await tx.returnRequest.update({ where: { id: row.id }, data: { status } });
    }
    return row.id;
  }
  const close = (tx: TestTx, id: string, data: Record<string, unknown>) =>
    tx.returnRequest.update({ where: { id }, data: { status: "refunded", ...data } as never });

  it("cu 0 lei pe produse și pe transport: închis", async () => {
    await accepts(async (tx) => {
      await close(tx, await makeReturn(tx), { refundedAt: new Date(), refundProductsMinor: 0 });
    });
  });

  it.each([
    ["suma produselor necompletată (una setată, una nulă)", { refundedAt: new Date() }],
    ["bani pe produse", { refundedAt: new Date(), refundProductsMinor: 1 }],
    [
      "bani pe transport",
      {
        refundedAt: new Date(),
        refundProductsMinor: 0,
        refundShippingMinor: 1,
        refundShippingReason: "motiv",
      },
    ],
    ["momentul necompletat (una setată, una nulă)", { refundProductsMinor: 0 }],
  ])("fără rambursare, dar cu %s: refuzat", async (_label, data) => {
    await rejects(
      async (tx) => close(tx, await makeReturn(tx), data),
      /return_request_refunded_ck/,
    );
  });
});

describe("linia de reducere din puncte pe factură", () => {
  const invoiceLine = async (tx: TestTx, over: Record<string, unknown>) => {
    const order = await makeOrder(tx);
    const invoice = await tx.invoice.create({
      data: { orderId: order.id, kind: "invoice", docKey: "invoice", totalMinor: 100, taxMinor: 0 },
    });
    return tx.invoiceLine.create({
      data: {
        invoiceId: invoice.id,
        position: 1,
        kind: "discount",
        orderLineId: "linie-1",
        sku: null,
        title: "Reducere din puncte de loialitate",
        unitName: "buc",
        quantityTicks: 10_000n,
        unitPriceMinor: 100,
        lineTotalMinor: 100,
        netMinor: 83,
        taxMinor: 17,
        taxRateBps: 2100,
        ...over,
      } as never,
    });
  };

  it("se acceptă: legată de linia comenzii, fără SKU, cu sume pozitive (semnul îl dă tipul)", async () => {
    await accepts((tx) => invoiceLine(tx, {}));
  });

  it.each([
    [
      "fără linia comenzii (una setată, una nulă)",
      { orderLineId: null },
      /invoice_line_source_check/,
    ],
    ["cu SKU", { sku: "SKU" }, /invoice_line_source_check/],
    [
      "cu sume negative",
      { lineTotalMinor: -100, netMinor: -83, taxMinor: -17 },
      /invoice_line_amounts_check/,
    ],
  ])("%s: refuzată", async (_label, over, pattern) => {
    await rejects((tx) => invoiceLine(tx, over), pattern as RegExp);
  });
});
