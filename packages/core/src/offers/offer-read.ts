import type { Prisma } from "@ecom/db";
import { formatQuantity, quantityFromTicks } from "@ecom/shared";
import type { Db } from "../db-tx";
import type { OfferStatus } from "./offer-service";

/**
 * Citirile adminului pentru ofertele de plată (Faza 11): lista, detaliul și căutarea de produse pentru ecranul de creare. Nimic de
 * aici nu atinge prețul de achiziție (căutarea citește doar SKU, titlul produsului și starea de vânzare). Datele personale ale
 * clientului (email, telefon, adresă) se întorc doar cu `pii`.
 */
export const OFFER_LIST_VIEWS = ["open", "all"] as const;
export type OfferListView = (typeof OFFER_LIST_VIEWS)[number];

export interface OfferListRow {
  id: string;
  number: string;
  status: OfferStatus;
  customerName: string | null;
  email: string | null;
  totalMinor: number;
  expiresAt: Date;
  createdAt: Date;
  creatorLabel: string;
  staleReason: string | null;
  convertedOrderId: string | null;
}

export async function listOffers(
  db: Db,
  params: { view?: OfferListView; page?: number; pageSize?: number },
  viewer: { pii: boolean },
): Promise<{ rows: OfferListRow[]; total: number }> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 25, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where: Prisma.OrderOfferWhereInput =
    params.view === "all" ? {} : { status: { in: ["active", "stale"] } };
  const [total, rows] = await Promise.all([
    db.orderOffer.count({ where }),
    db.orderOffer.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    total,
    rows: rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status as OfferStatus,
      customerName: viewer.pii ? nameOf(row.shipping) : null,
      email: viewer.pii ? row.email : null,
      totalMinor: row.totalMinor,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      creatorLabel: row.creatorLabel,
      staleReason: row.staleReason,
      convertedOrderId: row.convertedOrderId,
    })),
  };
}

/** Câte oferte așteaptă o decizie (active sau «stale»), pentru indicatorul din listă. */
export async function countOpenOffers(db: Db): Promise<number> {
  return db.orderOffer.count({ where: { status: { in: ["active", "stale"] } } });
}

const nameOf = (shipping: unknown): string | null => {
  const value = (shipping as { fullName?: unknown } | null)?.fullName;
  return typeof value === "string" ? value : null;
};

export interface OfferDetail {
  id: string;
  number: string;
  status: OfferStatus;
  expiresAt: Date;
  createdAt: Date;
  creatorLabel: string;
  lastSentAt: Date | null;
  staleReason: string | null;
  staleAt: Date | null;
  cancelledAt: Date | null;
  convertedAt: Date | null;
  convertedOrder: { id: string; number: string } | null;
  shippingKind: "courier" | "pickup";
  shippingOfferCode: string;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Doar cu drept de date personale. */
  customer: {
    email: string;
    phone: string;
    fullName: string;
    street: string;
    postalCode: string;
    localityName: string;
    countyName: string;
    company: { name: string; vatId: string } | null;
  } | null;
  lines: Array<{
    sku: string;
    title: string;
    variantTitle: string | null;
    quantity: string;
    unitSymbol: string;
    unitPriceMinor: number;
    lineTotalMinor: number;
    vatMinor: number;
    state: string;
    leadTimeDays: number | null;
  }>;
  events: Array<{
    id: string;
    type: string;
    message: string;
    actorLabel: string | null;
    createdAt: Date;
  }>;
}

export async function getOfferDetail(
  db: Db,
  id: string,
  viewer: { pii: boolean },
): Promise<OfferDetail | null> {
  const offer = await db.orderOffer.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { position: "asc" } },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      convertedOrder: { select: { id: true, number: true } },
    },
  });
  if (!offer) return null;
  const address = offer.shipping as {
    fullName?: string;
    street?: string;
    postalCode?: string;
    localityName?: string;
    countyName?: string;
  };
  const company = offer.company as { name?: string; vatId?: string } | null;
  return {
    id: offer.id,
    number: offer.number,
    status: offer.status as OfferStatus,
    expiresAt: offer.expiresAt,
    createdAt: offer.createdAt,
    creatorLabel: offer.creatorLabel,
    lastSentAt: offer.lastSentAt,
    staleReason: offer.staleReason,
    staleAt: offer.staleAt,
    cancelledAt: offer.cancelledAt,
    convertedAt: offer.convertedAt,
    convertedOrder: offer.convertedOrder,
    shippingKind: offer.shippingKind === "pickup" ? "pickup" : "courier",
    shippingOfferCode: offer.shippingOfferCode,
    subtotalMinor: offer.subtotalMinor,
    shippingMinor: offer.shippingMinor,
    taxMinor: offer.taxMinor,
    totalMinor: offer.totalMinor,
    customer: viewer.pii
      ? {
          email: offer.email,
          phone: offer.phone,
          fullName: address.fullName ?? "",
          street: address.street ?? "",
          postalCode: address.postalCode ?? "",
          localityName: address.localityName ?? "",
          countyName: address.countyName ?? "",
          company:
            company?.name && company.vatId ? { name: company.name, vatId: company.vatId } : null,
        }
      : null,
    lines: offer.lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: formatQuantity(quantityFromTicks(line.quantity)),
      unitSymbol: line.unitSymbol,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      vatMinor: line.vatMinor,
      state: line.state,
      leadTimeDays: line.leadTimeDays,
    })),
    events: offer.events.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      actorLabel: event.actorLabel,
      createdAt: event.createdAt,
    })),
  };
}

export interface OfferVariantOption {
  variantId: string;
  sku: string;
  title: string;
}

/** Prisma se ocupă de % și _; un backslash rămas la capăt strică comparația LIKE, deci se scoate. */
const clean = (value: string) => value.replaceAll("\\", "");

/** Căutarea de produse pentru oferta nouă: după SKU sau titlu, doar produse fizice active (digitalele nu intră în oferte). */
export async function searchOfferVariants(
  db: Db,
  query: string,
  limit = 12,
): Promise<OfferVariantOption[]> {
  const text = clean(query.trim().slice(0, 80)).trim();
  if (text.length < 2) return [];
  const rows = await db.productVariant.findMany({
    where: {
      product: { status: "active", deletedAt: null, type: "physical" },
      OR: [
        { sku: { contains: text, mode: "insensitive" } },
        { product: { title: { contains: text, mode: "insensitive" } } },
      ],
    },
    orderBy: [{ sku: "asc" }],
    take: Math.min(Math.max(limit, 1), 25),
    select: { id: true, sku: true, product: { select: { title: true } } },
  });
  return rows.map((row) => ({ variantId: row.id, sku: row.sku, title: row.product.title }));
}
