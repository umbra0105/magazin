import type { Prisma, PrismaClient } from "@ecom/db";
import { assertCan, type PermissionSubject } from "../rbac/can";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Raportul «vânzări per grup de clienți» (Faza 15, docs/09 §6): pe o perioadă, câte comenzi, ce valoare și ce AVANTAJ s-a acordat
 * fiecărui grup (diferența dintre prețul public curent și ce a plătit clientul, calculată de motor la plasare și păstrată pe
 * comandă). Comenzile anulate nu se numără. ⚠️ Nu atinge costul de achiziție: avantajul nu îl conține și nu se poate deduce din el
 * (nu există profit în raport). Cere `reports.read`.
 */

export interface GroupSalesRow {
  /** `null` = comenzi fără grup (oaspeți și clienți fără grup atribuit). */
  groupId: string | null;
  groupName: string | null;
  orders: number;
  /** Totalul comenzilor (bani, TVA inclus, transport inclus). */
  totalMinor: number;
  /** Avantajul acordat (bani): prețul public curent minus ce s-a plătit pe produse. */
  advantageMinor: number;
}

export interface GroupSalesReport {
  from: Date;
  to: Date;
  rows: GroupSalesRow[];
  totals: { orders: number; totalMinor: number; advantageMinor: number };
}

export async function salesByGroup(
  db: Db,
  subject: PermissionSubject | null,
  range: { from: Date; to: Date },
): Promise<GroupSalesReport> {
  assertCan(subject, "reports.read");
  const grouped = await db.order.groupBy({
    by: ["customerGroupId"],
    where: { placedAt: { gte: range.from, lt: range.to }, status: { not: "cancelled" } },
    _count: { _all: true },
    _sum: { totalMinor: true, groupAdvantageMinor: true },
  });
  const ids = grouped.flatMap((row) => (row.customerGroupId ? [row.customerGroupId] : []));
  const found = await db.customerGroup.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const names = new Map(found.map((group) => [group.id, group.name]));
  const rows = grouped
    .map((row): GroupSalesRow => ({
      groupId: row.customerGroupId,
      groupName: row.customerGroupId ? (names.get(row.customerGroupId) ?? null) : null,
      orders: row._count._all,
      totalMinor: row._sum.totalMinor ?? 0,
      advantageMinor: row._sum.groupAdvantageMinor ?? 0,
    }))
    .sort(
      (a, b) =>
        b.totalMinor - a.totalMinor || (a.groupName ?? "").localeCompare(b.groupName ?? "", "ro"),
    );
  return {
    from: range.from,
    to: range.to,
    rows,
    totals: rows.reduce(
      (sum, row) => ({
        orders: sum.orders + row.orders,
        totalMinor: sum.totalMinor + row.totalMinor,
        advantageMinor: sum.advantageMinor + row.advantageMinor,
      }),
      { orders: 0, totalMinor: 0, advantageMinor: 0 },
    ),
  };
}
