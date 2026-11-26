import type { Db } from "../db-tx";
import { LoyaltyError } from "./loyalty-errors";

/**
 * Registrul de puncte (Faza 15b): SINGURUL cod care scrie în `loyalty_transaction`, `loyalty_lot` și `loyalty_lot_entry`. Toate
 * funcțiile care scriu primesc tranzacția apelantului, blochează întâi contul (`FOR UPDATE`), deci operațiile aceluiași client
 * se serializează, și sunt idempotente prin cheie. Soldul nu se scrie de aici: îl ține triggerul din registru, care refuză
 * orice scădere sub 0 în afară de revocarea unui retur.
 *
 * Loturi: punctele se cheltuie din lotul care expiră primul. Punctele întoarse (anulare, abandon, retur) formează loturi noi cu
 * data lotului din care plecaseră, dar nu mai devreme de `graceDays` zile de la întoarcere. Pe un sold negativ, orice lot nou
 * acoperă întâi datoria. Regula păzită de teste: soldul = suma registrului; restul loturilor = max(sold, 0).
 */

const DAY_MS = 86_400_000;

function assertPoints(points: number): void {
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new LoyaltyError("LOYALTY_INVALID_POINTS", "Numărul de puncte trebuie să fie pozitiv");
  }
}

/** Creează contul dacă lipsește și îl blochează; întoarce soldul de sub blocare. */
export async function lockAccount(tx: Db, customerId: string): Promise<number> {
  await tx.loyaltyAccount.createMany({ data: [{ customerId }], skipDuplicates: true });
  const rows = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM loyalty_account WHERE "customerId" = ${customerId} FOR UPDATE`;
  return rows[0]?.balance ?? 0;
}

export async function readBalance(db: Db, customerId: string): Promise<number> {
  const account = await db.loyaltyAccount.findUnique({
    where: { customerId },
    select: { balance: true },
  });
  return account?.balance ?? 0;
}

/** Punctele care se pot cheltui ACUM: soldul fără loturile expirate pe care jobul nu le-a scăzut încă. */
export async function spendableBalance(db: Db, customerId: string, now: Date): Promise<number> {
  const balance = await readBalance(db, customerId);
  if (balance <= 0) return balance;
  const expired = await db.loyaltyLot.aggregate({
    where: { customerId, remaining: { gt: 0 }, expiresAt: { lte: now } },
    _sum: { remaining: true },
  });
  return balance - (expired._sum.remaining ?? 0);
}

const FIFO = [{ expiresAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

const exists = async (tx: Db, idempotencyKey: string): Promise<boolean> =>
  (await tx.loyaltyTransaction.findUnique({ where: { idempotencyKey }, select: { id: true } })) !==
  null;

interface Row {
  customerId: string;
  orderId?: string;
  type: "earn" | "redeem" | "release" | "expire" | "adjust" | "revoke";
  points: number;
  reason?: string;
  actorId?: string;
  idempotencyKey: string;
  createdAt: Date;
}

const write = (tx: Db, row: Row) =>
  tx.loyaltyTransaction.create({ data: row, select: { id: true, balanceAfter: true } });

/** Ia `points` din loturile date, în ordinea lor; întoarce cât a rămas neacoperit. */
async function consume(
  tx: Db,
  transactionId: string,
  lots: ReadonlyArray<{ id: string; remaining: number }>,
  points: number,
): Promise<number> {
  let left = points;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    if (take <= 0) continue;
    await tx.loyaltyLotEntry.create({ data: { transactionId, lotId: lot.id, points: -take } });
    left -= take;
  }
  return left;
}

/** Un lot nou; `debt` (soldul negativ dinainte) se acoperă întâi din el. Întoarce datoria rămasă. */
async function createLot(
  tx: Db,
  input: {
    transactionId: string;
    customerId: string;
    points: number;
    expiresAt: Date;
    originLotId?: string;
    createdAt: Date;
  },
  debt: number,
): Promise<number> {
  const lot = await tx.loyaltyLot.create({
    data: { ...input, remaining: input.points },
    select: { id: true, remaining: true },
  });
  if (debt <= 0) return 0;
  const covered = Math.min(debt, input.points);
  await consume(tx, input.transactionId, [lot], covered);
  return debt - covered;
}

/** Acumularea unei comenzi: o singură dată (cheie și index unic în bază). `false` dacă era deja scrisă sau are 0 puncte. */
export async function earnPoints(
  tx: Db,
  input: { customerId: string; orderId: string; points: number; expiresAt: Date; now: Date },
): Promise<boolean> {
  if (input.points === 0) return false;
  assertPoints(input.points);
  await lockAccount(tx, input.customerId);
  const key = `earn:${input.orderId}`;
  if (await exists(tx, key)) return false;
  const row = await write(tx, {
    customerId: input.customerId,
    orderId: input.orderId,
    type: "earn",
    points: input.points,
    idempotencyKey: key,
    createdAt: input.now,
  });
  await createLot(
    tx,
    {
      transactionId: row.id,
      customerId: input.customerId,
      points: input.points,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    },
    input.points - row.balanceAfter,
  );
  return true;
}

/**
 * Rezervă punctele unei comenzi, în ACEEAȘI tranzacție cu rezervarea de stoc. Două cereri simultane pe același sold: a doua
 * așteaptă blocarea contului și vede ce a cheltuit prima; baza refuză oricum un sold negativ.
 */
export async function redeemPoints(
  tx: Db,
  input: { customerId: string; orderId: string; points: number; now: Date },
): Promise<void> {
  assertPoints(input.points);
  await lockAccount(tx, input.customerId);
  const spendable = await spendableBalance(tx, input.customerId, input.now);
  if (input.points > spendable) {
    throw new LoyaltyError(
      "LOYALTY_INSUFFICIENT_POINTS",
      "Nu ai destule puncte disponibile pentru această comandă",
      { requested: input.points, available: Math.max(spendable, 0) },
    );
  }
  const row = await write(tx, {
    customerId: input.customerId,
    orderId: input.orderId,
    type: "redeem",
    points: -input.points,
    idempotencyKey: `redeem:${input.orderId}`,
    createdAt: input.now,
  });
  const lots = await tx.loyaltyLot.findMany({
    where: { customerId: input.customerId, remaining: { gt: 0 }, expiresAt: { gt: input.now } },
    orderBy: [...FIFO],
    select: { id: true, remaining: true },
  });
  if ((await consume(tx, row.id, lots, input.points)) !== 0) {
    throw new LoyaltyError("LOYALTY_INSUFFICIENT_POINTS", "Loturile nu acoperă punctele cerute");
  }
}

/**
 * Întoarce o parte din punctele folosite pe o comandă (anulare, abandon, retur), CA PUNCTE. `false` dacă cheia a fost deja
 * folosită. Se întorc întâi cele cu valabilitatea cea mai lungă; fiecare își păstrează data, dar nu expiră mai devreme de
 * `graceDays` zile de acum. Nu se întoarce niciodată mai mult decât s-a folosit.
 */
export async function releasePoints(
  tx: Db,
  input: {
    customerId: string;
    orderId: string;
    points: number;
    now: Date;
    graceDays: number;
    key: string;
  },
): Promise<boolean> {
  assertPoints(input.points);
  await lockAccount(tx, input.customerId);
  if (await exists(tx, input.key)) return false;
  const used = await tx.loyaltyLotEntry.findMany({
    where: { transaction: { orderId: input.orderId, type: "redeem" } },
    select: { points: true, lot: { select: { id: true, expiresAt: true } } },
  });
  const restored = await tx.loyaltyLot.groupBy({
    by: ["originLotId"],
    where: { transaction: { orderId: input.orderId, type: "release" } },
    _sum: { points: true },
  });
  const back = new Map(restored.map((r) => [r.originLotId, r._sum.points ?? 0]));
  const open = used
    .map((entry) => ({
      lot: entry.lot,
      points: -entry.points - (back.get(entry.lot.id) ?? 0),
    }))
    .filter((entry) => entry.points > 0)
    .sort(
      (a, b) =>
        b.lot.expiresAt.getTime() - a.lot.expiresAt.getTime() || a.lot.id.localeCompare(b.lot.id),
    );
  if (input.points > open.reduce((sum, entry) => sum + entry.points, 0)) {
    throw new LoyaltyError(
      "LOYALTY_RELEASE_INVALID",
      "Se întorc mai multe puncte decât s-au folosit pe comandă",
    );
  }
  const row = await write(tx, {
    customerId: input.customerId,
    orderId: input.orderId,
    type: "release",
    points: input.points,
    idempotencyKey: input.key,
    createdAt: input.now,
  });
  const graceEnd = input.now.getTime() + input.graceDays * DAY_MS;
  let left = input.points;
  let debt = input.points - row.balanceAfter;
  for (const entry of open) {
    if (left === 0) break;
    const points = Math.min(left, entry.points);
    // grația 0 = fără termen de grație: rămâne data lotului din care plecaseră punctele
    const expiresAt =
      input.graceDays > 0
        ? new Date(Math.max(entry.lot.expiresAt.getTime(), graceEnd))
        : entry.lot.expiresAt;
    debt = await createLot(
      tx,
      {
        transactionId: row.id,
        customerId: input.customerId,
        points,
        expiresAt,
        originLotId: entry.lot.id,
        createdAt: input.now,
      },
      debt,
    );
    left -= points;
  }
  return true;
}

/**
 * Revocă puncte acordate (retur, anulare). SINGURA operație care poate duce soldul sub 0 (punctele erau deja cheltuite). Ia
 * întâi din lotul comenzii, apoi din celelalte, în ordinea expirării; restul rămâne datorie.
 */
export async function revokePoints(
  tx: Db,
  input: { customerId: string; orderId: string; points: number; now: Date; key: string },
): Promise<boolean> {
  assertPoints(input.points);
  await lockAccount(tx, input.customerId);
  if (await exists(tx, input.key)) return false;
  const row = await write(tx, {
    customerId: input.customerId,
    orderId: input.orderId,
    type: "revoke",
    points: -input.points,
    idempotencyKey: input.key,
    createdAt: input.now,
  });
  const lots = await tx.loyaltyLot.findMany({
    where: { customerId: input.customerId, remaining: { gt: 0 } },
    orderBy: [...FIFO],
    select: { id: true, remaining: true, transaction: { select: { orderId: true, type: true } } },
  });
  const own = lots.filter(
    (lot) => lot.transaction.type === "earn" && lot.transaction.orderId === input.orderId,
  );
  await consume(tx, row.id, [...own, ...lots.filter((lot) => !own.includes(lot))], input.points);
  return true;
}

/**
 * Expiră restul unui lot a cărui dată a trecut. Punctele rezervate într-o comandă activă au ieșit deja din lot, deci nu se ating.
 * Întoarce punctele expirate (0 dacă nu e nimic de făcut).
 */
export async function expireLot(tx: Db, input: { lotId: string; now: Date }): Promise<number> {
  const head = await tx.loyaltyLot.findUnique({
    where: { id: input.lotId },
    select: { customerId: true },
  });
  if (!head) return 0;
  await lockAccount(tx, head.customerId);
  // recitit sub blocare: o răscumpărare simultană poate să-l fi consumat
  const lot = await tx.loyaltyLot.findUniqueOrThrow({
    where: { id: input.lotId },
    select: { id: true, customerId: true, remaining: true, expiresAt: true },
  });
  if (lot.remaining === 0 || lot.expiresAt.getTime() > input.now.getTime()) return 0;
  const row = await write(tx, {
    customerId: lot.customerId,
    type: "expire",
    points: -lot.remaining,
    idempotencyKey: `expire:${lot.id}`,
    createdAt: input.now,
  });
  await consume(tx, row.id, [lot], lot.remaining);
  return lot.remaining;
}

/** Ajustarea manuală din admin: motiv obligatoriu; scăderea nu poate depăși soldul. `false` la o cheie deja folosită. */
export async function adjustPoints(
  tx: Db,
  input: {
    customerId: string;
    points: number;
    reason: string;
    actorId: string;
    /** Expirarea punctelor adăugate (folosită doar la ajustarea pozitivă). */
    expiresAt: Date;
    now: Date;
    key: string;
  },
): Promise<boolean> {
  const reason = input.reason.trim();
  if (!Number.isSafeInteger(input.points) || input.points === 0 || reason === "") {
    throw new LoyaltyError(
      "LOYALTY_ADJUST_INVALID",
      "Ajustarea cere un număr de puncte diferit de zero și un motiv",
    );
  }
  const balance = await lockAccount(tx, input.customerId);
  if (await exists(tx, input.key)) return false;
  if (input.points < 0 && -input.points > balance) {
    throw new LoyaltyError(
      "LOYALTY_INSUFFICIENT_POINTS",
      "Nu poți scădea mai multe puncte decât are clientul",
      { available: Math.max(balance, 0) },
    );
  }
  const row = await write(tx, {
    customerId: input.customerId,
    type: "adjust",
    points: input.points,
    reason,
    actorId: input.actorId,
    idempotencyKey: input.key,
    createdAt: input.now,
  });
  if (input.points > 0) {
    await createLot(
      tx,
      {
        transactionId: row.id,
        customerId: input.customerId,
        points: input.points,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      },
      input.points - row.balanceAfter,
    );
  } else {
    const lots = await tx.loyaltyLot.findMany({
      where: { customerId: input.customerId, remaining: { gt: 0 } },
      orderBy: [...FIFO],
      select: { id: true, remaining: true },
    });
    await consume(tx, row.id, lots, -input.points);
  }
  return true;
}
