import { enqueueDispatches } from "../email/dispatch";
import { inTx, type Db } from "../db-tx";
import { expireLot } from "./ledger";
import { readLoyaltySettings } from "./loyalty-settings";

/**
 * Joburile periodice ale punctelor (Faza 15b): expirarea loturilor ajunse la termen și emailul de avertizare. Amândouă sunt
 * idempotente și sigure la mai multe instanțe; cu programul de loialitate oprit nu fac nimic (punctele nu se pot folosi, deci
 * nici nu expiră cât e oprit). Ceasul vine de la apelant. Emailurile se pun în outbox; le trimite workerul, prin coadă.
 */
export const LOYALTY_WARNING_TEMPLATE = "loyalty.expiry_warning";

const BATCH = 500;
const DAY_MS = 86_400_000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ExpireResult {
  lots: number;
  points: number;
  failed: number;
  more: boolean;
}

export async function expireDuePoints(
  db: Db,
  options: { now: Date; limit?: number },
): Promise<ExpireResult> {
  const result: ExpireResult = { lots: 0, points: 0, failed: 0, more: false };
  if (!(await readLoyaltySettings(db)).active) return result;
  const limit = options.limit ?? BATCH;
  const due = await db.loyaltyLot.findMany({
    where: { remaining: { gt: 0 }, expiresAt: { lte: options.now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true },
  });
  for (const { id } of due.slice(0, limit)) {
    try {
      const points = await inTx(db, (tx) => expireLot(tx, { lotId: id, now: options.now }));
      if (points > 0) {
        result.lots += 1;
        result.points += points;
      }
    } catch {
      result.failed += 1;
    }
  }
  result.more = due.length > limit;
  return result;
}

export interface WarningResult {
  queued: number;
  failed: number;
  more: boolean;
}

/** Un email pe lot, cu `expiryWarningDays` zile înainte de expirare: lotul e «revendicat» prin `warnedAt` în aceeași tranzacție. */
export async function sendExpiryWarnings(
  db: Db,
  options: { now: Date; limit?: number },
): Promise<WarningResult> {
  const result: WarningResult = { queued: 0, failed: 0, more: false };
  const settings = await readLoyaltySettings(db);
  if (!settings.active) return result;
  const limit = options.limit ?? BATCH;
  const horizon = new Date(options.now.getTime() + settings.expiryWarningDays * DAY_MS);
  const lots = await db.loyaltyLot.findMany({
    where: {
      remaining: { gt: 0 },
      warnedAt: null,
      expiresAt: { gt: options.now, lte: horizon },
      account: { customer: { anonymizedAt: null } },
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true, account: { select: { customer: { select: { email: true } } } } },
  });
  for (const lot of lots.slice(0, limit)) {
    const recipient = lot.account.customer.email.trim().toLowerCase();
    try {
      const queued = await inTx(db, async (tx) => {
        const claimed = await tx.loyaltyLot.updateMany({
          where: { id: lot.id, warnedAt: null, remaining: { gt: 0 } },
          data: { warnedAt: options.now },
        });
        if (claimed.count === 0 || !EMAIL_SHAPE.test(recipient)) return false;
        await enqueueDispatches(tx, [
          {
            template: LOYALTY_WARNING_TEMPLATE,
            eventKey: `loyalty-expiry:${lot.id}`,
            recipient,
            audience: "customer",
            data: { lotId: lot.id },
          },
        ]);
        return true;
      });
      if (queued) result.queued += 1;
    } catch {
      result.failed += 1;
    }
  }
  result.more = lots.length > limit;
  return result;
}
