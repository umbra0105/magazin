import type { Prisma } from "@ecom/db";
import { QUANTITY_FACTOR, formatQuantity, quantityFromTicks, stepsIn } from "@ecom/shared";
import type { Db } from "../db-tx";
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  RETURN_STATUSES,
  returnRefundKey,
  type ReturnStatus,
} from "./return-constants";
import { ReturnError } from "./return-errors";

/**
 * Citirile retururilor. CLIENTUL vede doar ce e al lui (filtru pe `userId` în fiecare interogare; un retur străin se comportă ca unul
 * inexistent) și NICIODATĂ nota internă, starea stornoului, evenimentele interne sau marcajele de stoc. ADMINUL vede tot, cu emailul
 * clientului doar când are `customers.read_pii` (apelantul decide `withContact`). Listele de câmpuri sunt explicite.
 */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max = 300): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : null;

const qty = (ticks: bigint | null): string | null =>
  ticks === null ? null : formatQuantity(quantityFromTicks(ticks));

export interface ReturnItemView {
  id: string;
  orderLineId: string;
  title: string;
  variantTitle: string | null;
  sku: string;
  unitSymbol: string;
  requestedQty: string;
  acceptedQty: string | null;
  reasonCode: string;
  reasonText: string | null;
  condition: string | null;
}

export interface CustomerReturnEvent {
  type: string;
  at: Date;
  awb: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  amountMinor: number | null;
}

export interface CustomerReturnView {
  id: string;
  number: number;
  status: ReturnStatus;
  order: { id: string; number: string };
  requestedAt: Date;
  customerNote: string | null;
  sendMode: string;
  returnCarrier: string | null;
  returnAwb: string | null;
  returnTrackingUrl: string | null;
  rejectReason: string | null;
  /** Sumele rambursate (doar după rambursare). */
  refundedProductsMinor: number | null;
  refundedShippingMinor: number | null;
  items: ReturnItemView[];
  events: CustomerReturnEvent[];
  canCancel: boolean;
}

const ITEM_SELECT = {
  id: true,
  orderLineId: true,
  requestedQty: true,
  acceptedQty: true,
  reasonCode: true,
  reasonText: true,
  condition: true,
  restockedAt: true,
  resellable: true,
  refundLineMinor: true,
  orderLine: { select: { title: true, variantTitle: true, sku: true, unitSymbol: true } },
} as const;

function itemView(i: {
  id: string;
  orderLineId: string;
  requestedQty: bigint;
  acceptedQty: bigint | null;
  reasonCode: string;
  reasonText: string | null;
  condition: string | null;
  orderLine: { title: string; variantTitle: string | null; sku: string; unitSymbol: string };
}): ReturnItemView {
  return {
    id: i.id,
    orderLineId: i.orderLineId,
    title: i.orderLine.title,
    variantTitle: i.orderLine.variantTitle,
    sku: i.orderLine.sku,
    unitSymbol: i.orderLine.unitSymbol,
    requestedQty: qty(i.requestedQty) ?? "0",
    acceptedQty: qty(i.acceptedQty),
    reasonCode: i.reasonCode,
    reasonText: i.reasonText,
    condition: i.condition,
  };
}

export async function listCustomerReturns(
  db: Db,
  userId: string,
): Promise<
  Array<{
    id: string;
    number: number;
    status: ReturnStatus;
    orderNumber: string;
    requestedAt: Date;
    itemCount: number;
  }>
> {
  const rows = await db.returnRequest.findMany({
    where: { userId },
    orderBy: { requestedAt: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      status: true,
      requestedAt: true,
      order: { select: { number: true } },
      _count: { select: { items: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status as ReturnStatus,
    orderNumber: r.order.number,
    requestedAt: r.requestedAt,
    itemCount: r._count.items,
  }));
}

export async function getCustomerReturn(
  db: Db,
  userId: string,
  returnId: string,
): Promise<CustomerReturnView> {
  const r = await db.returnRequest.findFirst({
    where: { id: returnId, userId },
    select: {
      id: true,
      number: true,
      status: true,
      requestedAt: true,
      customerNote: true,
      sendMode: true,
      returnCarrier: true,
      returnAwb: true,
      returnTrackingUrl: true,
      rejectReason: true,
      refundProductsMinor: true,
      refundShippingMinor: true,
      order: { select: { id: true, number: true } },
      items: { select: ITEM_SELECT, orderBy: { createdAt: "asc" } },
      events: {
        where: { visibleToCustomer: true },
        orderBy: { createdAt: "asc" },
        select: { type: true, createdAt: true, data: true },
      },
    },
  });
  if (!r) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
  const status = r.status as ReturnStatus;
  return {
    id: r.id,
    number: r.number,
    status,
    order: r.order,
    requestedAt: r.requestedAt,
    customerNote: r.customerNote,
    sendMode: r.sendMode,
    returnCarrier: r.returnCarrier,
    returnAwb: r.returnAwb,
    returnTrackingUrl: r.returnTrackingUrl,
    rejectReason: r.rejectReason,
    refundedProductsMinor: status === "refunded" ? r.refundProductsMinor : null,
    refundedShippingMinor: status === "refunded" ? r.refundShippingMinor : null,
    items: r.items.map(itemView),
    events: r.events.map((e) => {
      const data = asRecord(e.data);
      return {
        type: e.type,
        at: e.createdAt,
        awb: text(data["awb"], 80),
        carrier: text(data["carrier"], 80),
        trackingUrl: text(data["trackingUrl"]),
        amountMinor: typeof data["amountMinor"] === "number" ? data["amountMinor"] : null,
      };
    }),
    canCancel: (CUSTOMER_CANCELLABLE_STATUSES as readonly ReturnStatus[]).includes(status),
  };
}

// ---------------------------------------------------------------------------------------------------- admin

export interface AdminReturnFilters {
  status?: string;
  /** Număr de retur («R-12» sau «12») sau număr de comandă (parțial). */
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface AdminReturnRow {
  id: string;
  number: number;
  status: ReturnStatus;
  orderId: string;
  orderNumber: string;
  requestedAt: Date;
  itemCount: number;
  refundMinor: number | null;
}

export async function listAdminReturns(
  db: Db,
  filters: AdminReturnFilters,
): Promise<{ rows: AdminReturnRow[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.ReturnRequestWhereInput = {};
  if (filters.status && (RETURN_STATUSES as readonly string[]).includes(filters.status)) {
    where.status = filters.status;
  }
  const search = filters.search?.trim();
  if (search) {
    const numeric = /^r?-?(\d{1,9})$/i.exec(search);
    where.OR = [
      ...(numeric ? [{ number: Number(numeric[1]) }] : []),
      { order: { number: { contains: search, mode: "insensitive" as const } } },
    ];
  }
  if (filters.from || filters.to) {
    where.requestedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const [total, rows] = await Promise.all([
    db.returnRequest.count({ where }),
    db.returnRequest.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        requestedAt: true,
        refundProductsMinor: true,
        refundShippingMinor: true,
        order: { select: { id: true, number: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status as ReturnStatus,
      orderId: r.order.id,
      orderNumber: r.order.number,
      requestedAt: r.requestedAt,
      itemCount: r._count.items,
      refundMinor:
        r.refundProductsMinor === null ? null : r.refundProductsMinor + r.refundShippingMinor,
    })),
  };
}

export interface AdminReturnItemView extends ReturnItemView {
  resellable: boolean | null;
  refundLineMinor: number | null;
  restocked: boolean;
  /** `true` când varianta are stoc gestionat și se poate repune pe stoc. */
  managed: boolean;
}

export interface AdminReturnDetail {
  id: string;
  number: number;
  status: ReturnStatus;
  order: {
    id: string;
    number: string;
    shippingMinor: number;
    totalMinor: number;
    paymentMethod: string;
    paymentStatus: string;
  };
  contactName: string | null;
  contactEmail: string | null;
  requestedAt: Date;
  customerNote: string | null;
  sendMode: string;
  returnCarrier: string | null;
  returnAwb: string | null;
  returnTrackingUrl: string | null;
  rejectReason: string | null;
  adminNote: string | null;
  refundProductsMinor: number | null;
  refundShippingMinor: number;
  refundShippingReason: string | null;
  refund: { id: string; status: string; amountMinor: number } | null;
  stornoState: string | null;
  stornoNote: string | null;
  items: AdminReturnItemView[];
  events: Array<{
    type: string;
    message: string;
    at: Date;
    actorLabel: string | null;
    visibleToCustomer: boolean;
  }>;
}

export async function getAdminReturn(
  db: Db,
  returnId: string,
  withContact: boolean,
): Promise<AdminReturnDetail> {
  const r = await db.returnRequest.findUnique({
    where: { id: returnId },
    select: {
      id: true,
      number: true,
      status: true,
      requestedAt: true,
      customerNote: true,
      sendMode: true,
      returnCarrier: true,
      returnAwb: true,
      returnTrackingUrl: true,
      rejectReason: true,
      adminNote: true,
      refundProductsMinor: true,
      refundShippingMinor: true,
      refundShippingReason: true,
      stornoState: true,
      stornoNote: true,
      user: { select: { name: true, email: true } },
      order: {
        select: {
          id: true,
          number: true,
          shippingMinor: true,
          totalMinor: true,
          paymentMethod: true,
          paymentStatus: true,
          addresses: { where: { kind: "billing" }, select: { fullName: true } },
        },
      },
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          ...ITEM_SELECT,
          orderLine: { select: { ...ITEM_SELECT.orderLine.select, variantId: true } },
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          type: true,
          message: true,
          createdAt: true,
          actorLabel: true,
          visibleToCustomer: true,
        },
      },
    },
  });
  if (!r) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
  const refund = await db.refund.findFirst({
    where: { idempotencyKey: { startsWith: returnRefundKey(returnId) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, amountMinor: true },
  });
  const variantIds = r.items
    .map((i) => i.orderLine.variantId)
    .filter((v): v is string => v !== null);
  const managed = new Set<string>();
  if (variantIds.length > 0) {
    const rows = await db.inventoryItem.findMany({
      where: { variantId: { in: variantIds } },
      select: { variantId: true },
    });
    for (const row of rows) managed.add(row.variantId);
  }
  return {
    id: r.id,
    number: r.number,
    status: r.status as ReturnStatus,
    order: {
      id: r.order.id,
      number: r.order.number,
      shippingMinor: r.order.shippingMinor,
      totalMinor: r.order.totalMinor,
      paymentMethod: r.order.paymentMethod,
      paymentStatus: r.order.paymentStatus,
    },
    contactName: r.order.addresses[0]?.fullName ?? r.user.name,
    contactEmail: withContact ? r.user.email : null,
    requestedAt: r.requestedAt,
    customerNote: r.customerNote,
    sendMode: r.sendMode,
    returnCarrier: r.returnCarrier,
    returnAwb: r.returnAwb,
    returnTrackingUrl: r.returnTrackingUrl,
    rejectReason: r.rejectReason,
    adminNote: r.adminNote,
    refundProductsMinor: r.refundProductsMinor,
    refundShippingMinor: r.refundShippingMinor,
    refundShippingReason: r.refundShippingReason,
    refund,
    stornoState: r.stornoState,
    stornoNote: r.stornoNote,
    items: r.items.map((i) => ({
      ...itemView(i),
      resellable: i.resellable,
      refundLineMinor: i.refundLineMinor,
      restocked: i.restockedAt !== null,
      managed: i.orderLine.variantId !== null && managed.has(i.orderLine.variantId),
    })),
    events: r.events.map((e) => ({
      type: e.type,
      message: e.message,
      at: e.createdAt,
      actorLabel: e.actorLabel,
      visibleToCustomer: e.visibleToCustomer,
    })),
  };
}

/** Retururile unei comenzi, pentru secțiunea «Retururi» din pagina comenzii (admin). */
export async function listOrderReturns(
  db: Db,
  orderId: string,
): Promise<
  Array<{ id: string; number: number; status: ReturnStatus; requestedAt: Date; itemCount: number }>
> {
  const rows = await db.returnRequest.findMany({
    where: { orderId },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      number: true,
      status: true,
      requestedAt: true,
      _count: { select: { items: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status as ReturnStatus,
    requestedAt: r.requestedAt,
    itemCount: r._count.items,
  }));
}

// ---------------------------------------------------------------------------------------------------- raport

export interface ReasonReportRow {
  reasonCode: string;
  returns: number;
  lines: number;
  /** Bucăți din liniile cu unitate întreagă (fără zecimale); unitățile cu zecimale (mp, kg) se numără doar la «linii». */
  pieces: number;
}

export interface ReasonReportFilters {
  from?: Date;
  to?: Date;
  /** Implicit: toate, mai puțin cele anulate. */
  status?: string;
}

/** Retururi, linii și bucăți pe motiv, pe perioadă (după data cererii). */
export async function returnReasonReport(
  db: Db,
  filters: ReasonReportFilters,
): Promise<ReasonReportRow[]> {
  const status =
    filters.status && (RETURN_STATUSES as readonly string[]).includes(filters.status)
      ? { status: filters.status }
      : { status: { not: "cancelled" } };
  const items = await db.returnItem.findMany({
    where: {
      return: {
        ...status,
        ...(filters.from || filters.to
          ? {
              requestedAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
    },
    select: {
      returnId: true,
      reasonCode: true,
      requestedQty: true,
      orderLine: { select: { unitDecimals: true } },
    },
  });
  const byReason = new Map<string, { returns: Set<string>; lines: number; pieces: bigint }>();
  for (const item of items) {
    const row = byReason.get(item.reasonCode) ?? {
      returns: new Set<string>(),
      lines: 0,
      pieces: 0n,
    };
    row.returns.add(item.returnId);
    row.lines += 1;
    if (item.orderLine.unitDecimals === 0)
      row.pieces += stepsIn(
        quantityFromTicks(item.requestedQty),
        quantityFromTicks(QUANTITY_FACTOR),
      );
    byReason.set(item.reasonCode, row);
  }
  return [...byReason.entries()]
    .map(([reasonCode, v]) => ({
      reasonCode,
      returns: v.returns.size,
      lines: v.lines,
      pieces: Number(v.pieces),
    }))
    .sort((a, b) => b.returns - a.returns || a.reasonCode.localeCompare(b.reasonCode));
}
