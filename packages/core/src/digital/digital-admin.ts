import { inTx, type Db } from "../db-tx";
import { addOrderEvent, lockOrder } from "../orders/order-service";
import { DigitalError } from "./digital-errors";

/**
 * Drepturile de acces digitale, văzute și gestionate de admin (Faza 14b): listele pe comandă, jurnalul de accesări și acțiunile
 * (resetarea contorului, prelungirea, revocarea, restabilirea). Fiecare acțiune blochează comanda (`FOR UPDATE`), schimbă dreptul
 * într-o singură tranzacție și scrie un `OrderEvent` cu actorul; auditul îl scrie acțiunea de server (actorul, acțiunea, dreptul;
 * niciodată motivul liber). Cheile de stocare nu ies de aici; IP-ul și user-agent-ul apar doar în jurnalul pentru `digital.view`.
 */
export interface DigitalAdminActor {
  label: string;
}

export const REASON_MIN = 3;
export const REASON_MAX = 300;

function reasonOf(text: string): string {
  const value = text.trim();
  if (value.length < REASON_MIN || value.length > REASON_MAX) {
    throw new DigitalError(
      "DIGITAL_INPUT_INVALID",
      `Motivul are între ${REASON_MIN} și ${REASON_MAX} de caractere`,
    );
  }
  return value;
}

export interface AdminEntitlementDto {
  id: string;
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  /** Totalul liniei (bani): suma care se rambursează la «Rambursează linia». */
  lineTotalMinor: number;
  productId: string;
  productTitle: string;
  customerEmail: string;
  grantReason: "payment" | "delivery" | "admin";
  grantedAt: Date;
  downloadCount: number;
  maxDownloads: number | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastAccessAt: Date | null;
}

const entitlementSelect = {
  id: true,
  orderId: true,
  orderLineId: true,
  productId: true,
  grantReason: true,
  grantedAt: true,
  downloadCount: true,
  maxDownloads: true,
  revokedAt: true,
  revokedReason: true,
  order: { select: { number: true } },
  orderLine: { select: { lineTotalMinor: true } },
  customer: { select: { email: true } },
  product: { select: { title: true } },
  accessLogs: { orderBy: { createdAt: "desc" as const }, take: 1, select: { createdAt: true } },
} as const;

type EntitlementRow = {
  id: string;
  orderId: string;
  orderLineId: string;
  productId: string;
  grantReason: string;
  grantedAt: Date;
  downloadCount: number;
  maxDownloads: number | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  order: { number: string };
  orderLine: { lineTotalMinor: number };
  customer: { email: string };
  product: { title: string };
  accessLogs: Array<{ createdAt: Date }>;
};

const toDto = (row: EntitlementRow): AdminEntitlementDto => ({
  id: row.id,
  orderId: row.orderId,
  orderNumber: row.order.number,
  orderLineId: row.orderLineId,
  lineTotalMinor: row.orderLine.lineTotalMinor,
  productId: row.productId,
  productTitle: row.product.title,
  customerEmail: row.customer.email,
  grantReason: row.grantReason as AdminEntitlementDto["grantReason"],
  grantedAt: row.grantedAt,
  downloadCount: row.downloadCount,
  maxDownloads: row.maxDownloads,
  revokedAt: row.revokedAt,
  revokedReason: row.revokedReason,
  lastAccessAt: row.accessLogs[0]?.createdAt ?? null,
});

export async function listEntitlementsForOrder(
  db: Db,
  orderId: string,
): Promise<AdminEntitlementDto[]> {
  const rows = await db.digitalEntitlement.findMany({
    where: { orderId },
    orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
    select: entitlementSelect,
  });
  return rows.map(toDto);
}

export interface EntitlementListFilter {
  /** Număr de comandă sau email, parțial. */
  query?: string;
  status?: "active" | "revoked" | "all";
  productId?: string;
  page?: number;
  pageSize?: number;
}

export interface EntitlementPage {
  rows: AdminEntitlementDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Lista tuturor drepturilor de acces (ecranul «Acces digital»): căutare după comandă sau email, stare, produs. */
export async function listEntitlements(
  db: Db,
  filter: EntitlementListFilter = {},
): Promise<EntitlementPage> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const query = filter.query?.trim() ?? "";
  const where = {
    ...(filter.status === "active" ? { revokedAt: null } : {}),
    ...(filter.status === "revoked" ? { revokedAt: { not: null } } : {}),
    ...(filter.productId ? { productId: filter.productId } : {}),
    ...(query
      ? {
          OR: [
            { order: { number: { contains: query, mode: "insensitive" as const } } },
            { customer: { email: { contains: query, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    db.digitalEntitlement.count({ where }),
    db.digitalEntitlement.findMany({
      where,
      orderBy: [{ grantedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: entitlementSelect,
    }),
  ]);
  return { rows: rows.map(toDto), total, page, pageSize };
}

export interface AccessLogEntryDto {
  id: string;
  at: Date;
  action: "view" | "download";
  assetTitle: string | null;
  ip: string | null;
  userAgent: string | null;
}

export async function listAccessLog(
  db: Db,
  entitlementId: string,
  limit = 100,
): Promise<AccessLogEntryDto[]> {
  const rows = await db.digitalAccessLog.findMany({
    where: { entitlementId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: Math.min(Math.max(limit, 1), 500),
    select: {
      id: true,
      createdAt: true,
      action: true,
      ip: true,
      userAgent: true,
      asset: { select: { title: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    action: row.action as "view" | "download",
    assetTitle: row.asset?.title ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
  }));
}

// ----------------------------------------------------------------------------------------------------------------- acțiuni

async function lockEntitlement(tx: Db, entitlementId: string) {
  const found = await tx.digitalEntitlement.findUnique({
    where: { id: entitlementId },
    select: { id: true, orderId: true },
  });
  if (!found) throw new DigitalError("DIGITAL_NOT_FOUND", "Dreptul de acces nu există");
  await lockOrder(tx, found.orderId);
  const row = await tx.digitalEntitlement.findUniqueOrThrow({
    where: { id: entitlementId },
    select: {
      id: true,
      orderId: true,
      downloadCount: true,
      maxDownloads: true,
      revokedAt: true,
      product: { select: { title: true } },
    },
  });
  return row;
}

export async function resetDownloads(
  db: Db,
  entitlementId: string,
  reasonText: string,
  actor: DigitalAdminActor,
): Promise<void> {
  const reason = reasonOf(reasonText);
  await inTx(db, async (tx) => {
    const row = await lockEntitlement(tx, entitlementId);
    await tx.digitalEntitlement.update({ where: { id: row.id }, data: { downloadCount: 0 } });
    await addOrderEvent(tx, row.orderId, {
      type: "digital.counter_reset",
      message: `Contorul de descărcări a fost resetat (${row.product.title}): ${reason}`,
      data: { previousCount: row.downloadCount },
      actorLabel: actor.label,
    });
  });
}

/** Prelungire: adaugă descărcări la limită (`addDownloads`) sau scoate limita (`unlimited`). */
export async function extendEntitlement(
  db: Db,
  entitlementId: string,
  change: { addDownloads?: number; unlimited?: boolean },
  reasonText: string,
  actor: DigitalAdminActor,
): Promise<void> {
  const reason = reasonOf(reasonText);
  const add = change.addDownloads;
  if (
    !change.unlimited &&
    (add === undefined || !Number.isInteger(add) || add < 1 || add > 10_000)
  ) {
    throw new DigitalError(
      "DIGITAL_INPUT_INVALID",
      "Numărul de descărcări adăugate e între 1 și 10.000",
    );
  }
  await inTx(db, async (tx) => {
    const row = await lockEntitlement(tx, entitlementId);
    if (row.maxDownloads === null) {
      throw new DigitalError(
        "DIGITAL_INPUT_INVALID",
        "Dreptul nu are limită de descărcări: nu e nimic de prelungit",
      );
    }
    const next = change.unlimited ? null : row.maxDownloads + (add as number);
    await tx.digitalEntitlement.update({ where: { id: row.id }, data: { maxDownloads: next } });
    await addOrderEvent(tx, row.orderId, {
      type: "digital.extended",
      message: change.unlimited
        ? `Accesul a devenit fără limită de descărcări (${row.product.title}): ${reason}`
        : `Limita de descărcări a crescut cu ${add} (${row.product.title}): ${reason}`,
      actorLabel: actor.label,
    });
  });
}

export async function revokeEntitlement(
  db: Db,
  entitlementId: string,
  reasonText: string,
  actor: DigitalAdminActor,
  now: Date,
): Promise<void> {
  const reason = reasonOf(reasonText);
  await inTx(db, async (tx) => {
    const row = await lockEntitlement(tx, entitlementId);
    if (row.revokedAt) return; // idempotent
    await tx.digitalEntitlement.update({
      where: { id: row.id },
      data: { revokedAt: now, revokedReason: reason, revokedBy: actor.label },
    });
    await addOrderEvent(tx, row.orderId, {
      type: "digital.revoked",
      message: `Acces digital retras (${row.product.title}): ${reason}`,
      actorLabel: actor.label,
    });
  });
}

export async function restoreEntitlement(
  db: Db,
  entitlementId: string,
  reasonText: string,
  actor: DigitalAdminActor,
): Promise<void> {
  const reason = reasonOf(reasonText);
  await inTx(db, async (tx) => {
    const row = await lockEntitlement(tx, entitlementId);
    if (!row.revokedAt) return; // idempotent
    await tx.digitalEntitlement.update({
      where: { id: row.id },
      data: { revokedAt: null, revokedReason: null, revokedBy: null },
    });
    await addOrderEvent(tx, row.orderId, {
      type: "digital.restored",
      message: `Acces digital restabilit (${row.product.title}): ${reason}`,
      actorLabel: actor.label,
    });
  });
}
