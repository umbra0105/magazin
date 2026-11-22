import { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";

/**
 * Citirile facturării pentru admin (Faza 13): documentele unei comenzi, lista documentelor și lista «comenzi confirmate fără
 * factură». Doar citire; nicio sumă nu se recalculează aici (documentul își păstrează sumele de la emitere). Nimic din costul de
 * achiziție și nimic din datele clientului în afară de numărul comenzii.
 */
export interface InvoiceEventDto {
  id: string;
  type: string;
  message: string;
  createdAt: Date;
}

export interface InvoiceDto {
  id: string;
  orderId: string;
  orderNumber: string;
  kind: "proforma" | "invoice" | "storno";
  docKey: string;
  parentId: string | null;
  status: "queued" | "issuing" | "issued" | "failed" | "skipped";
  provider: string | null;
  simulated: boolean;
  series: string | null;
  number: string | null;
  efacturaStatus: string;
  efacturaCheckedAt: Date | null;
  currency: string;
  totalMinor: number;
  taxMinor: number;
  useStock: boolean;
  attempts: number;
  nextAttemptAt: Date | null;
  lastErrorCode: string | null;
  lastError: string | null;
  issuedAt: Date | null;
  createdAt: Date;
  requestedBy: string | null;
}

export interface InvoiceDetailDto extends InvoiceDto {
  events: InvoiceEventDto[];
  lines: Array<{
    position: number;
    kind: string;
    title: string;
    sku: string | null;
    unitName: string;
    quantityTicks: bigint;
    lineTotalMinor: number;
    taxMinor: number;
    dischargeStock: boolean;
  }>;
}

const SELECT = {
  id: true,
  orderId: true,
  kind: true,
  docKey: true,
  parentId: true,
  status: true,
  provider: true,
  simulated: true,
  series: true,
  number: true,
  efacturaStatus: true,
  efacturaCheckedAt: true,
  currency: true,
  totalMinor: true,
  taxMinor: true,
  useStock: true,
  attempts: true,
  nextAttemptAt: true,
  lastErrorCode: true,
  lastError: true,
  issuedAt: true,
  createdAt: true,
  requestedBy: true,
  order: { select: { number: true } },
} satisfies Prisma.InvoiceSelect;

type Row = Prisma.InvoiceGetPayload<{ select: typeof SELECT }>;

function toDto(row: Row): InvoiceDto {
  const { order, ...rest } = row;
  return { ...rest, orderNumber: order.number } as InvoiceDto;
}

/** Documentele unei comenzi, cu jurnalul și liniile lor, în ordinea creării. */
export async function listOrderInvoices(db: Db, orderId: string): Promise<InvoiceDetailDto[]> {
  const rows = await db.invoice.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      ...SELECT,
      events: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, type: true, message: true, createdAt: true },
      },
      lines: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          kind: true,
          title: true,
          sku: true,
          unitName: true,
          quantityTicks: true,
          lineTotalMinor: true,
          taxMinor: true,
          dischargeStock: true,
        },
      },
    },
  });
  return rows.map((row) => {
    const { events, lines, ...base } = row;
    return { ...toDto(base as Row), events, lines };
  });
}

export interface InvoiceListFilter {
  status?: InvoiceDto["status"];
  kind?: InvoiceDto["kind"];
  /** Număr de comandă, serie sau număr de document. */
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listInvoices(
  db: Db,
  filter: InvoiceListFilter = {},
): Promise<{ rows: InvoiceDto[]; total: number }> {
  const search = filter.search?.trim();
  const where: Prisma.InvoiceWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(search
      ? {
          OR: [
            { order: { number: { contains: search, mode: "insensitive" } } },
            { number: { contains: search, mode: "insensitive" } },
            { series: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.invoice.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(filter.limit ?? 50, 200),
      skip: filter.offset ?? 0,
      select: SELECT,
    }),
    db.invoice.count({ where }),
  ]);
  return { rows: rows.map(toDto), total };
}

/** Câte documente cer atenție (eșuate sau cu diferență de sumă). */
export async function countInvoicesNeedingAttention(db: Db): Promise<number> {
  return db.invoice.count({
    where: { OR: [{ status: "failed" }, { lastErrorCode: "INVOICE_TOTAL_MISMATCH" }] },
  });
}

export interface UninvoicedOrderDto {
  orderId: string;
  number: string;
  placedAt: Date;
  paymentMethod: string;
  paymentStatus: string;
  totalMinor: number;
  /** Angajări de stoc încă deschise: cât timp comanda nu e facturată (cu descărcare), bucățile rămân angajate. */
  openCommitments: number;
  /** Documentul de factură există, dar a eșuat. */
  failedInvoiceId: string | null;
}

interface UninvoicedRow {
  orderId: string;
  number: string;
  placedAt: Date;
  paymentMethod: string;
  paymentStatus: string;
  totalMinor: number;
  openCommitments: number;
  failedInvoiceId: string | null;
}

/**
 * Comenzile CONFIRMATE (de facturat acum, după regula metodei de plată) fără factură în coadă sau emisă: card și transfer după
 * plată, ramburs de la plasare (la «La comandă», după expediere). Altfel ar rămâne angajate la nesfârșit (D1.5, punctul 6).
 * Comenzile de pe canale externe nu intră.
 */
export async function listUninvoicedOrders(
  db: Db,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: UninvoicedOrderDto[]; total: number }> {
  const limit = Math.min(options.limit ?? 100, 500);
  const offset = options.offset ?? 0;
  const due = Prisma.sql`
    o."externalId" IS NULL
    AND o.status NOT IN ('cancelled', 'draft', 'returned')
    AND (
      (o."paymentMethod" IN ('card', 'bank_transfer') AND o."paymentStatus" = 'paid')
      OR (o."paymentMethod" = 'cod' AND (
        NOT EXISTS (SELECT 1 FROM order_line l WHERE l."orderId" = o.id AND l."stockState" = 'on_order')
        OR o."fulfillmentStatus" IN ('in_transit', 'delivered')
      ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM invoice i
      WHERE i."orderId" = o.id AND i.kind = 'invoice' AND i.status IN ('queued', 'issuing', 'issued')
    )`;
  const rows = await db.$queryRaw<UninvoicedRow[]>(Prisma.sql`
    SELECT o.id AS "orderId", o.number, o."placedAt", o."paymentMethod", o."paymentStatus", o."totalMinor",
      (SELECT count(*)::int FROM stock_commitment c
        WHERE c."refType" = ${ORDER_REF_TYPE} AND c."refId" = o.id AND c.status = 'open') AS "openCommitments",
      (SELECT i.id FROM invoice i WHERE i."orderId" = o.id AND i.kind = 'invoice' AND i.status = 'failed' LIMIT 1) AS "failedInvoiceId"
    FROM customer_order o
    WHERE ${due}
    ORDER BY o."placedAt" ASC, o.id ASC
    LIMIT ${limit} OFFSET ${offset}`);
  const totalRows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM customer_order o WHERE ${due}`);
  return { rows, total: totalRows[0]?.n ?? 0 };
}

export interface InvoiceQuantityWarningDto {
  sku: string;
  productTitle: string;
  /** Pasul de vânzare efectiv, în zecimi de miime de unitate. */
  stepTicks: number;
}

/**
 * Produsele al căror pas de vânzare dă cantități cu MAI MULT de 2 zecimale pe factură (SmartBill acceptă cel mult 2, cu rotunjire la
 * cea mai apropiată cifră; răspunsul contabilului din 2026-10-28). Pasul efectiv = al variantei, altfel al produsului. O comandă cu
 * o astfel de cantitate NU se emite: construirea facturii o refuză (`INVOICE_QUANTITY_PRECISION`), deci pasul se corectează înainte.
 * Avertizare la configurare, în ecranul Facturare; produsele arhivate nu intră.
 */
export async function listInvoiceQuantityWarnings(
  db: Db,
  options: { limit?: number } = {},
): Promise<{ rows: InvoiceQuantityWarningDto[]; total: number }> {
  const limit = Math.min(options.limit ?? 50, 200);
  const rows = await db.$queryRaw<InvoiceQuantityWarningDto[]>(Prisma.sql`
    SELECT v.sku AS "sku", p.title AS "productTitle", COALESCE(v."saleStep", p."saleStep") AS "stepTicks"
    FROM product_variant v JOIN product p ON p.id = v."productId"
    WHERE p.status <> 'archived'
      AND COALESCE(v."saleStep", p."saleStep") IS NOT NULL
      AND COALESCE(v."saleStep", p."saleStep") % 100 <> 0
    ORDER BY p.title ASC, v.sku ASC
    LIMIT ${limit}`);
  const totalRows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM product_variant v JOIN product p ON p.id = v."productId"
    WHERE p.status <> 'archived'
      AND COALESCE(v."saleStep", p."saleStep") IS NOT NULL
      AND COALESCE(v."saleStep", p."saleStep") % 100 <> 0`);
  return { rows, total: totalRows[0]?.n ?? 0 };
}
