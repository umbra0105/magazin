import { z } from "zod";
import type { PrismaClient } from "@ecom/db";
import { ValidationError } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { maskEmail } from "../customers/customer-group-service";
import { inTx } from "../db-tx";
import { assertCan, can, type PermissionSubject } from "../rbac/can";
import { adjustPoints, readBalance } from "./ledger";
import {
  customerLoyaltyOverview,
  type LoyaltyHistoryRow,
  type LoyaltyOverview,
} from "./loyalty-read";
import { readLoyaltySettings } from "./loyalty-settings";
import { addMonths, earnBaseMinor } from "./order-loyalty";
import { earnedPoints } from "../pricing/points";

/**
 * Punctele de loialitate în admin (Faza 15b), cu permisiunile verificate aici, pe server:
 *  - `loyalty.view`: căutarea clienților cu puncte, fișa unui client și raportul «datorie în puncte»;
 *  - `loyalty.adjust`: ajustarea manuală, cu motiv obligatoriu.
 * Emailul se vede întreg doar cu `customers.read_pii`. Auditul păstrează identificatori și numere: nici email, nici nume, nici
 * textul motivului (motivul stă în registrul de puncte). Raportul nu conține date personale.
 */
export const ADJUST_REASON_MAX = 300;
export const ADJUST_POINTS_MAX = 1_000_000;

const adjustSchema = z.object({
  customerId: z.string().min(1).max(64),
  points: z
    .number()
    .int()
    .min(-ADJUST_POINTS_MAX)
    .max(ADJUST_POINTS_MAX)
    .refine((value) => value !== 0, "Scrie un număr de puncte diferit de zero"),
  reason: z.string().trim().min(3, "Scrie motivul ajustării").max(ADJUST_REASON_MAX),
  /** Cheia cererii din formular: aceeași cerere trimisă de două ori se aplică o singură dată. */
  requestKey: z.string().uuid(),
});

export interface LoyaltyAdminDeps {
  db: PrismaClient;
  audit: AuditService;
  now?: () => Date;
}

export interface LoyaltyAdminCustomer extends Omit<LoyaltyOverview, "history"> {
  id: string;
  name: string;
  email: string;
  history: Array<LoyaltyHistoryRow & { reason: string | null }>;
}

export interface LoyaltyCustomerRow {
  id: string;
  name: string;
  email: string;
  balance: number;
}

export interface LoyaltyDebtReport {
  generatedAt: Date;
  /** Puncte disponibile (restul loturilor neexpirate), ale conturilor active. */
  availablePoints: number;
  availableMinor: number;
  /** Puncte în așteptare (comenzi livrate, încă neacordate). */
  pendingPoints: number;
  pendingMinor: number;
  /** Solduri negative (după retururi), în puncte, ca număr negativ. */
  negativePoints: number;
  /** Disponibilele, pe luna în care expiră (`AAAA-LL`). */
  months: Array<{ month: string; points: number; valueMinor: number }>;
}

const REPORT_PAGE = 50;

export class LoyaltyAdminService {
  private readonly now: () => Date;

  constructor(private readonly deps: LoyaltyAdminDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private shownEmail(subject: PermissionSubject | null, email: string): string {
    return can(subject, "customers.read_pii") ? email : maskEmail(email);
  }

  /** Clienții cu cont de puncte (sau căutați după nume ori email, ca să li se poată face o primă ajustare). */
  async search(subject: PermissionSubject | null, query: string): Promise<LoyaltyCustomerRow[]> {
    assertCan(subject, "loyalty.view");
    const text = query.trim().slice(0, 80);
    const users = await this.deps.db.user.findMany({
      where: {
        anonymizedAt: null,
        ...(text
          ? {
              OR: [
                { name: { contains: text, mode: "insensitive" } },
                { email: { contains: text, mode: "insensitive" } },
              ],
            }
          : { loyaltyAccount: { isNot: null } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: REPORT_PAGE,
      select: { id: true, name: true, email: true, loyaltyAccount: { select: { balance: true } } },
    });
    return users.map((user) => ({
      id: user.id,
      name: user.name,
      email: this.shownEmail(subject, user.email),
      balance: user.loyaltyAccount?.balance ?? 0,
    }));
  }

  async customer(
    subject: PermissionSubject | null,
    customerId: string,
  ): Promise<LoyaltyAdminCustomer> {
    assertCan(subject, "loyalty.view");
    const user = await this.deps.db.user.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new ValidationError("Clientul nu există");
    const overview = await customerLoyaltyOverview(this.deps.db, customerId, this.now());
    const reasons = await this.deps.db.loyaltyTransaction.findMany({
      where: { id: { in: overview.history.map((row) => row.id) }, reason: { not: null } },
      select: { id: true, reason: true },
    });
    const byId = new Map(reasons.map((row) => [row.id, row.reason]));
    return {
      ...overview,
      id: user.id,
      name: user.name,
      email: this.shownEmail(subject, user.email),
      history: overview.history.map((row) => ({ ...row, reason: byId.get(row.id) ?? null })),
    };
  }

  async adjust(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<{ applied: boolean; balance: number }> {
    assertCan(subject, "loyalty.adjust");
    const parsed = adjustSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Datele ajustării nu sunt valide", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const { customerId, points, reason, requestKey } = parsed.data;
    const now = this.now();
    const result = await inTx(this.deps.db, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: customerId },
        select: { anonymizedAt: true },
      });
      if (!user || user.anonymizedAt) throw new ValidationError("Clientul nu există");
      const settings = await readLoyaltySettings(tx);
      const applied = await adjustPoints(tx, {
        customerId,
        points,
        reason,
        actorId: subject.userId,
        expiresAt: addMonths(now, settings.expiryMonths),
        now,
        key: `adjust:${requestKey}`,
      });
      return { applied, balance: await readBalance(tx, customerId) };
    });
    if (result.applied) {
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "loyalty.adjust",
        entity: "loyalty_account",
        entityId: customerId,
        after: { points, balance: result.balance },
      });
    }
    return result;
  }

  /** «Datorie în puncte»: cât «datorează» magazinul clienților, fără nicio dată personală. */
  async debtReport(subject: PermissionSubject | null): Promise<LoyaltyDebtReport> {
    assertCan(subject, "loyalty.view");
    const db = this.deps.db;
    const now = this.now();
    const { pointValue } = await readLoyaltySettings(db);
    const active = { account: { customer: { anonymizedAt: null } } };
    const lots = await db.loyaltyLot.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { gt: now }, ...active },
      select: { remaining: true, expiresAt: true },
    });
    const months = new Map<string, number>();
    let available = 0;
    for (const lot of lots) {
      const month = lot.expiresAt.toISOString().slice(0, 7);
      months.set(month, (months.get(month) ?? 0) + lot.remaining);
      available += lot.remaining;
    }
    const negative = await db.loyaltyAccount.aggregate({
      where: { balance: { lt: 0 }, customer: { anonymizedAt: null } },
      _sum: { balance: true },
    });
    const waiting = await db.order.findMany({
      where: {
        loyaltyEarnRateMinor: { not: null },
        loyaltyEarnDueAt: { not: null },
        loyaltyGrantedAt: null,
        status: { notIn: ["cancelled", "returned"] },
        fulfillmentStatus: { not: "returned" },
      },
      select: { id: true, loyaltyEarnRateMinor: true },
    });
    let pending = 0;
    for (const order of waiting) {
      pending += earnedPoints(
        await earnBaseMinor(db, order.id),
        order.loyaltyEarnRateMinor as number,
      );
    }
    return {
      generatedAt: now,
      availablePoints: available,
      availableMinor: available * pointValue,
      pendingPoints: pending,
      pendingMinor: pending * pointValue,
      negativePoints: negative._sum.balance ?? 0,
      months: [...months]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, points]) => ({ month, points, valueMinor: points * pointValue })),
    };
  }
}
