import { compareQuantity, quantityFromTicks } from "@ecom/shared";
import type { Db } from "../db-tx";
import { orderLoyaltyView, type OrderLoyaltyView } from "../loyalty/loyalty-read";
import { loadReturnableLines, type ReturnableLine } from "../returns/return-lines";
import { resolveReturnWindow, type ReturnWindow } from "../returns/return-delivery";
import { ownedOrderWhere, ownedOrdersWhere, type AccountUser } from "./order-ownership";
import { AccountError } from "./account-errors";

/**
 * Comenzile clientului, așa cum le vede el în cont (Faza 14). CITIRE DOAR, cu proprietatea verificată în fiecare interogare
 * (`ownedOrdersWhere`): o comandă străină se comportă ca una inexistentă. Listele de câmpuri sunt EXPLICITE (nu se întoarce niciodată
 * un rând întreg de comandă): nota internă, marcajul «La furnizor» (furnizor, notă), `OrderNote`, `adminNote`, IP-ul, datele
 * brute ale plăților și costul de achiziție nu apar nicăieri aici.
 *
 * Cronologia se construiește DOAR din evenimente dintr-o LISTĂ ALBĂ de tipuri, iar textul stocat al evenimentului (care poate
 * conține numele unui admin sau un motiv intern) NU se afișează: clientul vede doar tipul, momentul și câmpurile sigure
 * (AWB, curier, link de urmărire, suma rambursată).
 */
export const CUSTOMER_ORDER_EVENT_TYPES = [
  "order.placed",
  "payment.confirmed",
  "payment.failed",
  "order.processing",
  "shipment.created",
  "order.shipped",
  "order.delivered",
  "order.picked_up",
  "order.cancelled",
  "order.auto_cancelled",
  "payment.refunded",
] as const;

export interface TimelineEntry {
  type: string;
  at: Date;
  awb: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  amountMinor: number | null;
}

export interface AccountOrderSummary {
  id: string;
  number: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  totalMinor: number;
  lineCount: number;
}

export interface AccountOrderListPage {
  orders: AccountOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAccountOrders(
  db: Db,
  user: AccountUser,
  page: number,
  pageSize: number,
): Promise<AccountOrderListPage> {
  const safePage = Math.max(1, Math.floor(page));
  const size = Math.min(50, Math.max(1, Math.floor(pageSize)));
  const [total, rows] = await Promise.all([
    db.order.count({ where: ownedOrdersWhere(user) }),
    db.order.findMany({
      where: ownedOrdersWhere(user),
      orderBy: { placedAt: "desc" },
      skip: (safePage - 1) * size,
      take: size,
      select: {
        id: true,
        number: true,
        placedAt: true,
        status: true,
        paymentStatus: true,
        fulfillmentStatus: true,
        totalMinor: true,
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    total,
    page: safePage,
    pageSize: size,
    orders: rows.map((r) => ({
      id: r.id,
      number: r.number,
      placedAt: r.placedAt,
      status: r.status,
      paymentStatus: r.paymentStatus,
      fulfillmentStatus: r.fulfillmentStatus,
      totalMinor: r.totalMinor,
      lineCount: r._count.lines,
    })),
  };
}

export interface AccountOrderLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string;
  imageUrl: string | null;
  quantity: bigint;
  unitSymbol: string;
  unitDecimals: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  /** Folosit la «comandă din nou» (varianta, dacă mai există). */
  variantId: string | null;
}

export interface AccountAddressView {
  fullName: string;
  company: string | null;
  vatId: string | null;
  phone: string;
  street: string;
  postalCode: string;
  localityName: string;
  countyName: string;
  country: string;
}

export interface AccountShipmentView {
  carrier: string;
  awb: string;
  trackingUrl: string | null;
  status: string;
  deliveredAt: Date | null;
}

export interface AccountInvoiceView {
  id: string;
  kind: string;
  series: string | null;
  number: string | null;
  issuedAt: Date | null;
  simulated: boolean;
  totalMinor: number;
}

export interface AccountReturnSummary {
  id: string;
  number: number;
  status: string;
  requestedAt: Date;
}

export interface AccountOrderDetail {
  id: string;
  number: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  subtotalMinor: number;
  shippingMinor: number;
  codFeeMinor: number;
  discountMinor: number;
  /** Punctele comenzii (folosite, primite, de primit); `null` = nimic de arătat. */
  loyalty: OrderLoyaltyView | null;
  taxMinor: number;
  totalMinor: number;
  lines: AccountOrderLine[];
  shippingAddress: AccountAddressView | null;
  billingAddress: AccountAddressView | null;
  shipments: AccountShipmentView[];
  invoices: AccountInvoiceView[];
  timeline: TimelineEntry[];
  returns: AccountReturnSummary[];
  returnWindow: ReturnWindow;
  returnableLines: ReturnableLine[];
  /** Poate cere retur acum: livrare consemnată, în fereastră și cu cantități rămase. */
  canRequestReturn: boolean;
}

const ADDRESS_SELECT = {
  kind: true,
  fullName: true,
  company: true,
  vatId: true,
  phone: true,
  street: true,
  postalCode: true,
  localityName: true,
  countyName: true,
  country: true,
} as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown, max = 300): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : null;

export async function getAccountOrder(
  db: Db,
  user: AccountUser,
  orderId: string,
  now: Date,
): Promise<AccountOrderDetail> {
  const order = await db.order.findFirst({
    where: ownedOrderWhere(user, orderId),
    select: {
      id: true,
      number: true,
      placedAt: true,
      status: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      paymentMethod: true,
      subtotalMinor: true,
      shippingMinor: true,
      codFeeMinor: true,
      discountMinor: true,
      taxMinor: true,
      totalMinor: true,
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          variantTitle: true,
          sku: true,
          imageUrl: true,
          quantity: true,
          unitSymbol: true,
          unitDecimals: true,
          unitPriceMinor: true,
          lineTotalMinor: true,
          variantId: true,
        },
      },
      addresses: { select: ADDRESS_SELECT },
      shipments: {
        where: { kind: "outbound", status: { not: "cancelled" } },
        orderBy: { createdAt: "asc" },
        select: { carrier: true, awb: true, trackingUrl: true, status: true, deliveredAt: true },
      },
      invoices: {
        where: { status: "issued" },
        orderBy: { issuedAt: "asc" },
        select: {
          id: true,
          kind: true,
          series: true,
          number: true,
          issuedAt: true,
          simulated: true,
          totalMinor: true,
        },
      },
    },
  });
  if (!order) throw new AccountError("ACCOUNT_ORDER_NOT_FOUND", "Comanda nu există");

  const events = await db.orderEvent.findMany({
    where: { orderId: order.id, type: { in: [...CUSTOMER_ORDER_EVENT_TYPES] } },
    orderBy: { createdAt: "asc" },
    select: { type: true, createdAt: true, data: true },
  });
  const timeline: TimelineEntry[] = events.map((e) => {
    const data = asRecord(e.data);
    return {
      type: e.type,
      at: e.createdAt,
      awb: str(data["awb"], 80),
      carrier: str(data["carrier"], 80),
      trackingUrl: str(data["trackingUrl"]),
      amountMinor: typeof data["amountMinor"] === "number" ? data["amountMinor"] : null,
    };
  });

  const returns = await db.returnRequest.findMany({
    where: { orderId: order.id, userId: user.id },
    orderBy: { requestedAt: "desc" },
    select: { id: true, number: true, status: true, requestedAt: true },
  });
  const [returnWindow, returnableLines] = await Promise.all([
    resolveReturnWindow(db, order.id, now),
    loadReturnableLines(db, order.id),
  ]);
  const anyReturnable = returnableLines.some(
    (l) => compareQuantity(l.returnable, quantityFromTicks(0n)) > 0,
  );
  const view = (kind: string): AccountAddressView | null => {
    const a = order.addresses.find((x) => x.kind === kind);
    return a
      ? {
          fullName: a.fullName,
          company: a.company,
          vatId: a.vatId,
          phone: a.phone,
          street: a.street,
          postalCode: a.postalCode,
          localityName: a.localityName,
          countyName: a.countyName,
          country: a.country,
        }
      : null;
  };
  const loyalty = await orderLoyaltyView(db, order.id, user.id);
  return {
    loyalty,
    id: order.id,
    number: order.number,
    placedAt: order.placedAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentMethod: order.paymentMethod,
    subtotalMinor: order.subtotalMinor,
    shippingMinor: order.shippingMinor,
    codFeeMinor: order.codFeeMinor,
    discountMinor: order.discountMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    lines: order.lines,
    shippingAddress: view("shipping"),
    billingAddress: view("billing"),
    shipments: order.shipments,
    invoices: order.invoices,
    timeline,
    returns,
    returnWindow,
    returnableLines,
    canRequestReturn: returnWindow.open && anyReturnable && order.status !== "cancelled",
  };
}

/** O factură a clientului, pentru descărcare: întoarce id-ul DOAR dacă documentul e emis și aparține unei comenzi a lui. */
export async function findOwnedInvoiceId(
  db: Db,
  user: AccountUser,
  invoiceId: string,
): Promise<string | null> {
  const row = await db.invoice.findFirst({
    where: { id: invoiceId, status: "issued", order: ownedOrdersWhere(user) },
    select: { id: true },
  });
  return row?.id ?? null;
}
