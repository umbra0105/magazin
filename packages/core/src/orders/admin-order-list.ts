import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import type { AttentionReason } from "../payments/payment-errors";

/**
 * Lista comenzilor din admin (Faza 11): vederi implicite, căutare, filtre, sortare deterministă și numărători. Fiecare interogare
 * are `ORDER BY` determinist (cheia aleasă + `id`), deci paginile nu se suprapun și nu sar rânduri. Căutarea nu citește
 * `costPrice` și nu întoarce `productSnapshot`; contactul clientului (email, telefon, nume) se întoarce doar cu `pii`.
 */
export const ORDER_VIEWS = [
  "all",
  "to_process",
  "payment_pending",
  "attention",
  "supplier",
] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];

export const ORDER_SORTS = [
  "placed_desc",
  "placed_asc",
  "total_desc",
  "total_asc",
  "number_desc",
  "number_asc",
] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const EXPORT_LIMIT = 5000;

export interface OrderListQuery {
  view?: OrderView;
  /** Număr de comandă, email, telefon, nume sau CUI. */
  q?: string;
  status?: readonly string[];
  paymentStatus?: readonly string[];
  fulfillmentStatus?: readonly string[];
  paymentMethod?: readonly string[];
  delivery?: "courier" | "pickup";
  /** Interval de date pe `placedAt`: de la (inclusiv) până la (exclusiv). */
  from?: Date;
  to?: Date;
  minTotalMinor?: number;
  maxTotalMinor?: number;
  supplier?: boolean;
  attention?: boolean;
  installation?: readonly string[];
  sort?: OrderSort;
  page?: number;
  pageSize?: number;
}

/** Cele două condiții care fac o comandă «necesită atenție»: motiv activ pe o plată sau rambursare deschisă. */
export const ATTENTION_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { payments: { some: { attentionReason: { not: null }, attentionResolvedAt: null } } },
    { refunds: { some: { status: { in: ["requested", "manual_required", "failed"] } } } },
  ],
};

const ACTIVE = ["pending", "confirmed", "processing"];

const VIEW_WHERE: Record<OrderView, Prisma.OrderWhereInput> = {
  all: {},
  to_process: { status: "confirmed", fulfillmentStatus: "unfulfilled" },
  payment_pending: { status: "pending", paymentStatus: "pending" },
  attention: ATTENTION_WHERE,
  supplier: { supplierMarkedAt: { not: null }, status: { in: ACTIVE } },
};

/**
 * Textul căutat, normalizat: fără spații la capete, cel mult 100 de caractere și fără bară inversă (în `LIKE` ea e caracter de
 * scăpare: un text care se termină cu ea strică interogarea). `%` și `_` sunt scăpate de Prisma, deci rămân litere obișnuite.
 */
const clean = (q: string): string => q.replaceAll("\\", "").trim().slice(0, 100);

export function buildOrderWhere(query: OrderListQuery): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [VIEW_WHERE[query.view ?? "all"]];
  const q = clean(query.q ?? "");
  if (q !== "") {
    const number = q.replace(/\s+/g, "").toUpperCase();
    const digits = q.replace(/[^0-9+]/g, "");
    const or: Prisma.OrderWhereInput[] = [
      { number: { startsWith: number } },
      { number: { endsWith: number } },
      { email: { contains: q.toLowerCase() } },
      { addresses: { some: { fullName: { contains: q, mode: "insensitive" } } } },
      { addresses: { some: { vatId: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } } } },
    ];
    if (digits.length >= 4) or.push({ phone: { contains: digits.replace(/^\+/, "") } });
    and.push({ OR: or });
  }
  if (query.status?.length) and.push({ status: { in: [...query.status] } });
  if (query.paymentStatus?.length) and.push({ paymentStatus: { in: [...query.paymentStatus] } });
  if (query.fulfillmentStatus?.length) {
    and.push({ fulfillmentStatus: { in: [...query.fulfillmentStatus] } });
  }
  if (query.paymentMethod?.length) and.push({ paymentMethod: { in: [...query.paymentMethod] } });
  if (query.delivery === "pickup") and.push({ shippingMethodCode: "pickup" });
  if (query.delivery === "courier") and.push({ NOT: { shippingMethodCode: "pickup" } });
  if (query.from || query.to) {
    and.push({
      placedAt: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lt: query.to } : {}),
      },
    });
  }
  if (query.minTotalMinor !== undefined || query.maxTotalMinor !== undefined) {
    and.push({
      totalMinor: {
        ...(query.minTotalMinor !== undefined ? { gte: query.minTotalMinor } : {}),
        ...(query.maxTotalMinor !== undefined ? { lte: query.maxTotalMinor } : {}),
      },
    });
  }
  if (query.supplier === true) and.push({ supplierMarkedAt: { not: null } });
  if (query.attention === true) and.push(ATTENTION_WHERE);
  if (query.installation?.length) {
    and.push({ installationStatus: { in: [...query.installation] } });
  }
  return { AND: and };
}

export function buildOrderOrderBy(
  sort: OrderSort = "placed_desc",
): Prisma.OrderOrderByWithRelationInput[] {
  switch (sort) {
    case "placed_asc":
      return [{ placedAt: "asc" }, { id: "asc" }];
    case "total_desc":
      return [{ totalMinor: "desc" }, { placedAt: "desc" }, { id: "desc" }];
    case "total_asc":
      return [{ totalMinor: "asc" }, { placedAt: "desc" }, { id: "desc" }];
    case "number_desc":
      return [{ number: "desc" }, { id: "desc" }];
    case "number_asc":
      return [{ number: "asc" }, { id: "asc" }];
    default:
      return [{ placedAt: "desc" }, { id: "desc" }];
  }
}

export interface AdminOrderRow {
  id: string;
  number: string;
  placedAt: Date;
  /** Contactul se întoarce doar cu drept de date personale. */
  customerName: string | null;
  email: string | null;
  totalMinor: number;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  delivery: "courier" | "pickup";
  supplier: boolean;
  installationStatus: string | null;
  /** Motiv de atenție activ pe o plată sau rambursare deschisă. */
  attention: boolean;
  attentionReason: AttentionReason | null;
  /** Anulată cu bani încasați și nerambursați integral. */
  needsRefund: boolean;
}

export interface AdminOrderListResult {
  rows: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ROW_SELECT = {
  id: true,
  number: true,
  placedAt: true,
  email: true,
  totalMinor: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  paymentMethod: true,
  shippingMethodCode: true,
  supplierMarkedAt: true,
  installationStatus: true,
  addresses: { where: { kind: "billing" }, select: { fullName: true } },
  payments: {
    select: {
      status: true,
      amountMinor: true,
      refundCommittedMinor: true,
      attentionReason: true,
      attentionResolvedAt: true,
    },
  },
  refunds: {
    where: { status: { in: ["requested", "manual_required", "failed"] } },
    select: { id: true },
  },
} satisfies Prisma.OrderSelect;

type RowSource = Prisma.OrderGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(row: RowSource, pii: boolean): AdminOrderRow {
  const active = row.payments.find((p) => p.attentionReason && !p.attentionResolvedAt);
  const cancelledPaid =
    row.status === "cancelled" &&
    row.payments.some(
      (p) =>
        (p.status === "paid" || p.status === "refunded") && p.refundCommittedMinor < p.amountMinor,
    );
  return {
    id: row.id,
    number: row.number,
    placedAt: row.placedAt,
    customerName: pii ? (row.addresses[0]?.fullName ?? null) : null,
    email: pii ? row.email : null,
    totalMinor: row.totalMinor,
    status: row.status,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    paymentMethod: row.paymentMethod,
    delivery: row.shippingMethodCode === "pickup" ? "pickup" : "courier",
    supplier: row.supplierMarkedAt !== null,
    installationStatus: row.installationStatus,
    attention: active !== undefined || row.refunds.length > 0,
    attentionReason: active ? (active.attentionReason as AttentionReason) : null,
    needsRefund: cancelledPaid,
  };
}

export async function listAdminOrders(
  db: Db,
  query: OrderListQuery,
  viewer: { pii: boolean },
): Promise<AdminOrderListResult> {
  const where = buildOrderWhere(query);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(query.pageSize ?? 25)
    ? (query.pageSize ?? 25)
    : 25;
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const [total, rows] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: buildOrderOrderBy(query.sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ROW_SELECT,
    }),
  ]);
  return { rows: rows.map((row) => toRow(row, viewer.pii)), total, page, pageSize };
}

/** Rândurile pentru export (fără paginare, cel mult `EXPORT_LIMIT`), în aceeași ordine determinist. */
export async function listOrdersForExport(
  db: Db,
  query: OrderListQuery,
  viewer: { pii: boolean },
): Promise<{ rows: AdminOrderRow[]; truncated: boolean }> {
  const where = buildOrderWhere(query);
  const rows = await db.order.findMany({
    where,
    orderBy: buildOrderOrderBy(query.sort),
    take: EXPORT_LIMIT + 1,
    select: ROW_SELECT,
  });
  return {
    rows: rows.slice(0, EXPORT_LIMIT).map((row) => toRow(row, viewer.pii)),
    truncated: rows.length > EXPORT_LIMIT,
  };
}

export interface OrderViewCounts {
  to_process: number;
  payment_pending: number;
  attention: number;
  supplier: number;
  all: number;
}

/** Numărătorile vederilor implicite (aceleași condiții ca în listă: un test compară contorul cu lista). */
export async function countOrderViews(db: Db): Promise<OrderViewCounts> {
  const [all, to_process, payment_pending, attention, supplier] = await Promise.all(
    ORDER_VIEWS.map((view) => db.order.count({ where: buildOrderWhere({ view }) })),
  );
  return {
    all: all ?? 0,
    to_process: to_process ?? 0,
    payment_pending: payment_pending ?? 0,
    attention: attention ?? 0,
    supplier: supplier ?? 0,
  };
}
