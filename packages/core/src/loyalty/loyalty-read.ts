import type { Db } from "../db-tx";
import { earnedPoints } from "../pricing/points";
import { readBalance, spendableBalance } from "./ledger";
import { readLoyaltySettings } from "./loyalty-settings";
import { earnBaseMinor, pendingPoints, type PendingPoints } from "./order-loyalty";

/**
 * Punctele unui client, pentru contul lui și pentru fișa din admin (Faza 15b): sold, valoare în lei, puncte în așteptare cu data,
 * următorul lot care expiră și istoricul. `customerId` vine din sesiune (cont) sau de la un serviciu care a verificat permisiunea
 * (admin). Motivul ajustărilor manuale NU intră aici: e text intern, îl adaugă doar vederea din admin.
 */
export interface LoyaltyHistoryRow {
  id: string;
  createdAt: Date;
  type: string;
  points: number;
  balanceAfter: number;
  orderId: string | null;
  orderNumber: string | null;
}

export interface LoyaltyOverview {
  balance: number;
  /** Ce se poate folosi acum (fără loturile expirate încă nescăzute). */
  spendable: number;
  /** Valoarea în lei (bani) a punctelor care se pot folosi. */
  valueMinor: number;
  /** Grupul clientului acumulează puncte (Partenerii nu). */
  earns: boolean;
  pending: PendingPoints[];
  /** Cel mai apropiat lot care expiră: câte puncte și când. */
  nextExpiry: { points: number; expiresAt: Date } | null;
  history: LoyaltyHistoryRow[];
}

export const LOYALTY_HISTORY_LIMIT = 200;

export async function customerLoyaltyOverview(
  db: Db,
  customerId: string,
  now: Date,
): Promise<LoyaltyOverview> {
  const settings = await readLoyaltySettings(db);
  const user = await db.user.findUnique({
    where: { id: customerId },
    select: { customerGroup: { select: { earnsLoyaltyPoints: true } } },
  });
  const spendable = await spendableBalance(db, customerId, now);
  const next = await db.loyaltyLot.findFirst({
    where: { customerId, remaining: { gt: 0 }, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: { remaining: true, expiresAt: true },
  });
  const rows = await db.loyaltyTransaction.findMany({
    where: { customerId },
    orderBy: { seq: "desc" },
    take: LOYALTY_HISTORY_LIMIT,
    select: {
      id: true,
      createdAt: true,
      type: true,
      points: true,
      balanceAfter: true,
      orderId: true,
    },
  });
  const orders = await db.order.findMany({
    where: { id: { in: rows.flatMap((row) => (row.orderId ? [row.orderId] : [])) } },
    select: { id: true, number: true },
  });
  const numbers = new Map(orders.map((order) => [order.id, order.number]));
  return {
    balance: await readBalance(db, customerId),
    spendable,
    valueMinor: Math.max(spendable, 0) * settings.pointValue,
    earns: user?.customerGroup?.earnsLoyaltyPoints ?? true,
    pending: await pendingPoints(db, customerId),
    nextExpiry: next ? { points: next.remaining, expiresAt: next.expiresAt } : null,
    history: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      type: row.type,
      points: row.points,
      balanceAfter: row.balanceAfter,
      orderId: row.orderId && numbers.has(row.orderId) ? row.orderId : null,
      orderNumber: row.orderId ? (numbers.get(row.orderId) ?? null) : null,
    })),
  };
}

/** Punctele unei comenzi, pentru contul cumpărătorului: folosite, primite sau de primit (cu data, după livrare). */
export interface OrderLoyaltyView {
  pointsUsed: number;
  /** Punctele deja acordate pentru comandă; `null` = încă neacordate. */
  earned: number | null;
  /** Punctele de primit; `availableAt` lipsește cât timp comanda nu e livrată. */
  toEarn: { points: number; availableAt: Date | null } | null;
}

/** `null` = comanda nu are puncte sau punctele ei sunt ale altui cont (nu se arată nimic din ele). */
export async function orderLoyaltyView(
  db: Db,
  orderId: string,
  customerId: string,
): Promise<OrderLoyaltyView | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, loyaltyCustomerId: customerId },
    select: {
      status: true,
      fulfillmentStatus: true,
      loyaltyPointsUsed: true,
      loyaltyEarnRateMinor: true,
      loyaltyPointsToEarn: true,
      loyaltyEarnDueAt: true,
      loyaltyGrantedAt: true,
    },
  });
  if (!order) return null;
  let earned: number | null = null;
  let toEarn: OrderLoyaltyView["toEarn"] = null;
  if (order.loyaltyGrantedAt) {
    const sum = await db.loyaltyTransaction.aggregate({
      where: { customerId, orderId, type: "earn" },
      _sum: { points: true },
    });
    earned = sum._sum.points ?? 0;
  } else if (
    order.loyaltyEarnRateMinor !== null &&
    order.status !== "cancelled" &&
    order.status !== "returned" &&
    order.fulfillmentStatus !== "returned"
  ) {
    const points = order.loyaltyEarnDueAt
      ? earnedPoints(await earnBaseMinor(db, orderId), order.loyaltyEarnRateMinor)
      : (order.loyaltyPointsToEarn ?? 0);
    if (points > 0) toEarn = { points, availableAt: order.loyaltyEarnDueAt };
  }
  if (order.loyaltyPointsUsed === 0 && !earned && !toEarn) return null;
  return { pointsUsed: order.loyaltyPointsUsed, earned: earned || null, toEarn };
}

/** Nota din coș: «Ai N puncte (N lei)», doar când punctele chiar se pot folosi la finalizare. */
export async function redeemHint(
  db: Db,
  customerId: string,
  now: Date,
): Promise<{ points: number; valueMinor: number } | null> {
  const settings = await readLoyaltySettings(db);
  if (!settings.redeemAvailable) return null;
  const points = await spendableBalance(db, customerId, now);
  if (points < Math.max(1, settings.minRedeemPoints)) return null;
  return { points, valueMinor: points * settings.pointValue };
}
