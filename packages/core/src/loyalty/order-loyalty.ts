import type { Prisma } from "@ecom/db";
import { inTx, type Db } from "../db-tx";
import { earnedPoints, returnedPoints } from "../pricing/points";
import { RETURN_REFUND_KEY_PREFIX } from "../returns/return-constants";
import { readReturnWindowDays, resolveDeliveredAt } from "../returns/return-delivery";
import { returnWindowEnd } from "../returns/return-eligibility";
import { earnPoints, releasePoints, revokePoints } from "./ledger";
import { readLoyaltySettings } from "./loyalty-settings";

/**
 * Punctele unei comenzi (Faza 15b). `syncOrderLoyalty` e SINGURUL loc care ține registrul în acord cu comanda: citește starea din
 * bază și face doar diferența (întoarceri, revocări, data acordării), deci e idempotentă și poate fi chemată la orice eveniment.
 *  - anulare sau colet întors la expeditor: punctele folosite se întorc, cele acordate se revocă, nu se mai acordă nimic;
 *  - retur încheiat: se întorc punctele pentru reducerea liniilor returnate (cumulat, în jos; la retur integral toate), iar cele
 *    acordate peste ce se cuvine pe banii rămași se revocă;
 *  - rambursare integrală în afara unui retur: toate punctele folosite se întorc (banii se întorc ca bani, punctele ca puncte);
 *  - orice rambursare de bani în afara unui retur scade baza de acumulare; transportul rambursat într-un retur nu o scade;
 *  - livrare confirmată (sau accesul acordat, la digital): se calculează de când pot fi acordate punctele = sfârșitul ferestrei
 *    de retur (`returns.windowDays`); la comenzi mixte, momentul cel mai târziu.
 */

/**
 * Ce primește modulul de la comandă (ca la produsele digitale): scrierea evenimentelor și a celor două date ale punctelor de pe
 * comandă. Singurul fișier care scrie pe comandă rămâne `order-service.ts` (portul `LOYALTY_PORTS` de acolo).
 */
export interface LoyaltyPorts {
  emit: (
    tx: Db,
    orderId: string,
    event: { type: string; message: string; data?: Prisma.InputJsonValue },
  ) => Promise<void>;
  setEarnDates: (
    tx: Db,
    orderId: string,
    dates: { loyaltyEarnDueAt?: Date | null; loyaltyGrantedAt?: Date },
  ) => Promise<void>;
}

/** Evenimentele comenzii după care registrul se reaşază. */
export const LOYALTY_EVENT_TYPES: readonly string[] = [
  "order.cancelled",
  "order.auto_cancelled",
  "order.returned_to_sender",
  "order.delivered",
  "order.picked_up",
  "payment.stock_lost",
  "payment.refunded",
  "digital.fulfilled",
  "digital.granted",
];

/** Retururile care încă pot schimba ce se cuvine: cât sunt deschise, acordarea așteaptă. */
export const OPEN_RETURN_STATUSES = [
  "requested",
  "approved",
  "awaiting_shipment",
  "received",
  "inspected",
] as const;

const ORDER_SELECT = {
  id: true,
  status: true,
  fulfillmentStatus: true,
  paymentStatus: true,
  loyaltyCustomerId: true,
  loyaltyPointsUsed: true,
  loyaltyPointValueMinor: true,
  loyaltyEarnRateMinor: true,
  loyaltyEarnDueAt: true,
  loyaltyGrantedAt: true,
} satisfies Prisma.OrderSelect;

type LoyaltyOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

const isVoid = (order: Pick<LoyaltyOrder, "status" | "fulfillmentStatus">): boolean =>
  order.status === "cancelled" ||
  order.status === "returned" ||
  order.fulfillmentStatus === "returned";

/** Rambursările CONFIRMATE în afara retururilor, din plata care a confirmat comanda (o plată dublă returnată nu se numără). */
async function nonReturnRefundedMinor(db: Db, orderId: string): Promise<number> {
  const primary = await db.payment.findFirst({
    where: { orderId, status: { in: ["paid", "refunded"] } },
    orderBy: [{ capturedAt: "asc" }, { attemptNo: "asc" }],
    select: { id: true },
  });
  if (!primary) return 0;
  const sum = await db.refund.aggregate({
    where: {
      paymentId: primary.id,
      status: "confirmed",
      NOT: { idempotencyKey: { startsWith: RETURN_REFUND_KEY_PREFIX } },
    },
    _sum: { amountMinor: true },
  });
  return sum._sum.amountMinor ?? 0;
}

/** Banii plătiți pe produsele care aduc puncte și rămași la magazin. */
export async function earnBaseMinor(db: Db, orderId: string): Promise<number> {
  const lines = await db.orderLine.findMany({
    where: { orderId },
    select: {
      lineTotalMinor: true,
      loyaltyDiscountMinor: true,
      loyaltyEarnEligible: true,
      returnItems: {
        where: { return: { status: "refunded" } },
        select: { refundLineMinor: true },
      },
    },
  });
  const kept = lines.reduce((sum, line) => {
    if (!line.loyaltyEarnEligible) return sum;
    const refunded = line.returnItems.reduce((acc, item) => acc + (item.refundLineMinor ?? 0), 0);
    return sum + line.lineTotalMinor - line.loyaltyDiscountMinor - refunded;
  }, 0);
  return Math.max(0, kept - (await nonReturnRefundedMinor(db, orderId)));
}

/** De când pot fi acordate punctele, sau `null` cât timp comanda nu e livrată (accesul neacordat, la digital). */
export async function earnDueAt(db: Db, orderId: string): Promise<Date | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { fulfillmentStatus: true, lines: { select: { isDigital: true } } },
  });
  if (!order || order.lines.length === 0) return null;
  const moments: Date[] = [];
  if (order.lines.some((line) => !line.isDigital)) {
    if (order.fulfillmentStatus !== "delivered") return null;
    const delivered = await resolveDeliveredAt(db, orderId);
    if (!delivered) return null;
    moments.push(delivered);
  }
  const digital = order.lines.filter((line) => line.isDigital).length;
  if (digital > 0) {
    const granted = await db.digitalEntitlement.findMany({
      where: { orderId },
      select: { grantedAt: true },
    });
    if (granted.length < digital) return null;
    moments.push(...granted.map((g) => g.grantedAt));
  }
  const latest = new Date(Math.max(...moments.map((m) => m.getTime())));
  return returnWindowEnd(latest, await readReturnWindowDays(db));
}

/** Câte dintre punctele folosite trebuie să fie întoarse, după starea de acum a comenzii. */
async function returnTarget(db: Db, order: LoyaltyOrder): Promise<number> {
  const used = order.loyaltyPointsUsed;
  if (used === 0) return 0;
  if (isVoid(order)) return used;
  if (order.paymentStatus === "refunded" && (await nonReturnRefundedMinor(db, order.id)) > 0) {
    return used;
  }
  const returned = await db.returnItem.aggregate({
    where: { return: { orderId: order.id, status: "refunded" } },
    _sum: { loyaltyDiscountMinor: true },
  });
  const total = await db.orderLine.aggregate({
    where: { orderId: order.id },
    _sum: { loyaltyDiscountMinor: true },
  });
  return returnedPoints({
    returnedDiscountMinor: returned._sum.loyaltyDiscountMinor ?? 0,
    totalDiscountMinor: total._sum.loyaltyDiscountMinor ?? 0,
    pointValueMinor: order.loyaltyPointValueMinor ?? 1,
    pointsUsed: used,
  });
}

const ledgerSum = async (db: Db, orderId: string, type: string): Promise<number> => {
  const sum = await db.loyaltyTransaction.aggregate({
    where: { orderId, type },
    _sum: { points: true },
  });
  return Math.abs(sum._sum.points ?? 0);
};

const pointsText = (points: number): string => (points === 1 ? "1 punct" : `${points} puncte`);

/** Blochează comanda (același lacăt ca `lockOrder`) și citește instantaneul punctelor. */
async function lockLoyaltyOrder(tx: Db, orderId: string): Promise<LoyaltyOrder | null> {
  await tx.$queryRaw`SELECT id FROM customer_order WHERE id = ${orderId} FOR UPDATE`;
  return tx.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
}

export async function syncOrderLoyalty(
  tx: Db,
  orderId: string,
  now: Date,
  ports: LoyaltyPorts,
): Promise<void> {
  const { emit } = ports;
  const head = await tx.order.findUnique({
    where: { id: orderId },
    select: { loyaltyCustomerId: true, loyaltyPointsUsed: true, loyaltyEarnRateMinor: true },
  });
  const customerId = head?.loyaltyCustomerId;
  if (!customerId) return;
  if (head.loyaltyPointsUsed === 0 && head.loyaltyEarnRateMinor === null) return;
  const order = await lockLoyaltyOrder(tx, orderId);
  if (!order) return;
  const settings = await readLoyaltySettings(tx);

  const target = await returnTarget(tx, order);
  const released = await ledgerSum(tx, orderId, "release");
  if (target > released) {
    const points = target - released;
    await releasePoints(tx, {
      customerId,
      orderId,
      points,
      now,
      graceDays: settings.releasedGraceDays,
      key: `release:${orderId}:${target}`,
    });
    await emit(tx, orderId, {
      type: "loyalty.points_returned",
      message: `Au fost întoarse în cont ${pointsText(points)} folosite la această comandă`,
      data: { points },
    });
  }

  if (order.loyaltyEarnRateMinor === null) return;
  if (order.loyaltyGrantedAt === null) {
    const due = isVoid(order) ? null : await earnDueAt(tx, orderId);
    if ((due?.getTime() ?? null) !== (order.loyaltyEarnDueAt?.getTime() ?? null)) {
      await ports.setEarnDates(tx, orderId, { loyaltyEarnDueAt: due });
    }
    return;
  }
  const deserved = isVoid(order)
    ? 0
    : earnedPoints(await earnBaseMinor(tx, orderId), order.loyaltyEarnRateMinor);
  const earned = await ledgerSum(tx, orderId, "earn");
  const revoked = await ledgerSum(tx, orderId, "revoke");
  const extra = earned - revoked - deserved;
  if (extra > 0) {
    await revokePoints(tx, {
      customerId,
      orderId,
      points: extra,
      now,
      key: `revoke:${orderId}:${revoked + extra}`,
    });
    await emit(tx, orderId, {
      type: "loyalty.points_revoked",
      message: `Au fost retrase ${pointsText(extra)} acordate pentru această comandă`,
      data: { points: extra },
    });
  }
}

/** Se apelează din `addOrderEvent`, în aceeași tranzacție cu evenimentul. */
export async function scheduleOrderLoyalty(
  tx: Db,
  orderId: string,
  event: { type: string },
  ports: LoyaltyPorts,
  now: Date = new Date(),
): Promise<void> {
  if (!LOYALTY_EVENT_TYPES.includes(event.type)) return;
  await syncOrderLoyalty(tx, orderId, now, ports);
}

/** `acum + n luni` calendaristice (31 ianuarie + 1 lună = ultima zi din februarie). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const dueWhere = (now: Date): Prisma.OrderWhereInput => ({
  loyaltyEarnRateMinor: { not: null },
  loyaltyEarnDueAt: { lte: now },
  loyaltyGrantedAt: null,
  status: { notIn: ["cancelled", "returned"] },
  fulfillmentStatus: { not: "returned" },
  // doar pe banii chiar încasați (la ramburs: după «Marchează încasat»)
  paymentStatus: { in: ["paid", "partially_refunded", "refunded"] },
  returns: { none: { status: { in: [...OPEN_RETURN_STATUSES] } } },
});

export interface GrantResult {
  granted: number;
  points: number;
  failed: number;
  more: boolean;
}

/** Acordă punctele unei comenzi ajunse la termen, în tranzacția ei. `null` dacă între timp nu mai e eligibilă. */
export async function grantOrderPoints(
  tx: Db,
  orderId: string,
  now: Date,
  ports: LoyaltyPorts,
): Promise<number | null> {
  const order = await lockLoyaltyOrder(tx, orderId);
  if (!order?.loyaltyCustomerId || order.loyaltyEarnRateMinor === null) return null;
  const eligible = await tx.order.count({ where: { id: orderId, ...dueWhere(now) } });
  if (eligible === 0) return null;
  const settings = await readLoyaltySettings(tx);
  const user = await tx.user.findUnique({
    where: { id: order.loyaltyCustomerId },
    select: { anonymizedAt: true },
  });
  const points =
    user && user.anonymizedAt === null
      ? earnedPoints(await earnBaseMinor(tx, orderId), order.loyaltyEarnRateMinor)
      : 0;
  await earnPoints(tx, {
    customerId: order.loyaltyCustomerId,
    orderId,
    points,
    expiresAt: addMonths(now, settings.expiryMonths),
    now,
  });
  await ports.setEarnDates(tx, orderId, { loyaltyGrantedAt: now });
  if (points > 0) {
    await ports.emit(tx, orderId, {
      type: "loyalty.points_granted",
      message: `Au fost acordate ${pointsText(points)} pentru această comandă`,
      data: { points },
    });
  }
  return points;
}

/** Jobul de acordare: idempotent (o singură acumulare pe comandă, garantată și de bază). Cu programul oprit nu face nimic. */
export async function grantDuePoints(
  db: Db,
  options: { now: Date; ports: LoyaltyPorts; limit?: number },
): Promise<GrantResult> {
  const result: GrantResult = { granted: 0, points: 0, failed: 0, more: false };
  if (!(await readLoyaltySettings(db)).active) return result;
  const limit = options.limit ?? 200;
  const due = await db.order.findMany({
    where: dueWhere(options.now),
    orderBy: [{ loyaltyEarnDueAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true },
  });
  for (const { id } of due.slice(0, limit)) {
    try {
      const points = await inTx(db, (tx) => grantOrderPoints(tx, id, options.now, options.ports));
      if (points !== null) {
        result.granted += 1;
        result.points += points;
      }
    } catch {
      result.failed += 1;
    }
  }
  result.more = due.length > limit;
  return result;
}

export interface PendingPoints {
  orderId: string;
  orderNumber: string;
  points: number;
  availableAt: Date;
}

/** Punctele «în așteptare» ale clientului: comenzi livrate, cu fereastra de retur încă neîncheiată sau neacordate încă. */
export async function pendingPoints(db: Db, customerId: string): Promise<PendingPoints[]> {
  const orders = await db.order.findMany({
    where: {
      loyaltyCustomerId: customerId,
      loyaltyEarnRateMinor: { not: null },
      loyaltyEarnDueAt: { not: null },
      loyaltyGrantedAt: null,
      status: { notIn: ["cancelled", "returned"] },
      fulfillmentStatus: { not: "returned" },
    },
    orderBy: [{ loyaltyEarnDueAt: "asc" }, { id: "asc" }],
    select: { id: true, number: true, loyaltyEarnRateMinor: true, loyaltyEarnDueAt: true },
  });
  const rows = await Promise.all(
    orders.map(async (order) => ({
      orderId: order.id,
      orderNumber: order.number,
      points: earnedPoints(await earnBaseMinor(db, order.id), order.loyaltyEarnRateMinor as number),
      availableAt: order.loyaltyEarnDueAt as Date,
    })),
  );
  return rows.filter((row) => row.points > 0);
}
