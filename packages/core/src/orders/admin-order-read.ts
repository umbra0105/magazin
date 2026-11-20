import type { Db } from "../db-tx";
import type { AttentionReason } from "../payments/payment-errors";
import { pickupAddressTextFromSnapshot } from "../shipping/pickup-address";
import { listOrderNotes, type OrderNoteDto } from "./order-notes";

/**
 * Citirea detaliului unei comenzi pentru ADMIN (Faza 11): liniile (snapshot imuabil), sumele, adresele, plățile cu rambursările,
 * cronologia din `OrderEvent`, notele interne și emailurile comenzii. Fiecare secțiune sensibilă se ia DOAR dacă apelantul are
 * dreptul (`viewer`): contactul și adresele cer date personale, plățile cer `payments.read`, emailurile cer `email.read`. Fără
 * drept, secțiunea întoarce `null`, nu o variantă ascunsă din interfață. prețul de achiziție nu apare nicăieri (snapshot-ul liniei îl
 * exclude din construcție); `productSnapshot` nu se întoarce deloc.
 */
export interface AdminOrderViewer {
  /** Vede contactul clientului și adresele (`customers.read_pii` sau `orders.fulfill`). */
  pii: boolean;
  /** Vede plățile și rambursările (`payments.read`). */
  payments: boolean;
  /** Vede emailurile comenzii (`email.read`). */
  emails: boolean;
}

export interface AdminOrderLine {
  id: string;
  sku: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  quantityTicks: string;
  unitSymbol: string;
  unitDecimals: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  taxMinor: number;
  taxRateBps: number;
  stockState: string;
  leadTimeDays: number | null;
}

export interface AdminOrderAddress {
  kind: string;
  fullName: string;
  company: string | null;
  vatId: string | null;
  vatIdVerification: string | null;
  tradeRegisterNo: string | null;
  phone: string;
  street: string;
  postalCode: string;
  countyName: string;
  localityName: string;
  country: string;
}

export interface AdminOrderRefund {
  id: string;
  amountMinor: number;
  status: string;
  kind: string;
  reason: string;
  manualReference: string | null;
  failureMessage: string | null;
  actorLabel: string | null;
  limitedActor: boolean;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface AdminOrderPayment {
  id: string;
  attemptNo: number;
  provider: string;
  method: string;
  mode: string | null;
  status: string;
  amountMinor: number;
  capturedAmountMinor: number | null;
  refundCommittedMinor: number;
  cardLast4: string | null;
  attentionReason: AttentionReason | null;
  createdAt: Date;
  capturedAt: Date | null;
  refunds: AdminOrderRefund[];
}

export interface AdminOrderEvent {
  id: string;
  type: string;
  message: string;
  actorLabel: string | null;
  createdAt: Date;
}

export interface AdminOrderEmail {
  id: string;
  template: string;
  audience: string;
  recipient: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface AdminOrderDetail {
  id: string;
  number: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  channelName: string;
  paymentMethod: string;
  currency: string;
  contact: { email: string; phone: string } | null;
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    shippingMinor: number;
    codFeeMinor: number;
    taxMinor: number;
    totalMinor: number;
  };
  lines: AdminOrderLine[];
  shipping: {
    code: string;
    kind: string;
    carrier: string;
    service: string;
    estimatedDays: number | null;
    freeShipping: boolean;
    /** Adresa MAGAZINULUI din snapshot, la ridicare; niciodată adresa clientului. */
    pickupAddressText: string | null;
  };
  addresses: AdminOrderAddress[] | null;
  customerNote: string | null;
  installation: { requested: boolean; note: string | null; status: string | null };
  consent: { acceptedAt: Date; version: string };
  supplier: { markedAt: Date; markedBy: string; name: string | null; note: string | null } | null;
  reservationExpiresAt: Date | null;
  paymentRetryDeadlineAt: Date | null;
  events: AdminOrderEvent[];
  notes: OrderNoteDto[];
  payments: AdminOrderPayment[] | null;
  /** Ce se poate rambursa din plata încasată a comenzii (aceeași alegere ca în `requestOrderRefund`). */
  refundable: { paymentId: string; remainingMinor: number } | null;
  /** Comanda are bani încasați și nerambursați integral. */
  needsRefund: boolean;
  emails: AdminOrderEmail[] | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export async function getAdminOrderDetail(
  db: Db,
  orderId: string,
  viewer: AdminOrderViewer,
): Promise<AdminOrderDetail | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      channel: { select: { name: true } },
      lines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      addresses: true,
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!order) return null;
  const snapshot = asRecord(order.shippingSnapshot);
  const [notes, payments, emails] = await Promise.all([
    listOrderNotes(db, orderId),
    db.payment.findMany({
      where: { orderId },
      orderBy: [{ attemptNo: "asc" }, { id: "asc" }],
      include: { refunds: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    }),
    viewer.emails
      ? db.emailDispatch.findMany({
          where: { orderId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
        })
      : Promise.resolve(null),
  ]);
  const captured = payments
    .filter((p) => p.status === "paid" || p.status === "refunded")
    .sort(
      (a, b) =>
        (a.capturedAt?.getTime() ?? 0) - (b.capturedAt?.getTime() ?? 0) ||
        a.attemptNo - b.attemptNo,
    );
  const primary = captured[0];
  const needsRefund = captured.some((p) => p.refundCommittedMinor < p.amountMinor);
  return {
    id: order.id,
    number: order.number,
    placedAt: order.placedAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    channelName: order.channel.name,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    contact: viewer.pii ? { email: order.email, phone: order.phone } : null,
    totals: {
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      shippingMinor: order.shippingMinor,
      codFeeMinor: order.codFeeMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
    },
    lines: order.lines.map((line) => ({
      id: line.id,
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      imageUrl: line.imageUrl,
      quantityTicks: line.quantity.toString(),
      unitSymbol: line.unitSymbol,
      unitDecimals: line.unitDecimals,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      lineTotalMinor: line.lineTotalMinor,
      taxMinor: line.taxMinor,
      taxRateBps: line.taxRateBps,
      stockState: line.stockState,
      leadTimeDays: line.leadTimeDays,
    })),
    shipping: {
      code: order.shippingMethodCode,
      kind: text(snapshot["kind"], "courier"),
      carrier: text(snapshot["carrier"]),
      service: text(snapshot["service"]),
      estimatedDays:
        typeof snapshot["estimatedDays"] === "number" ? snapshot["estimatedDays"] : null,
      freeShipping: snapshot["freeShipping"] === true,
      pickupAddressText:
        snapshot["kind"] === "pickup" ? pickupAddressTextFromSnapshot(snapshot) : null,
    },
    addresses: viewer.pii
      ? order.addresses
          .slice()
          .sort((a, b) => a.kind.localeCompare(b.kind))
          .map((a) => ({
            kind: a.kind,
            fullName: a.fullName,
            company: a.company,
            vatId: a.vatId,
            vatIdVerification: a.vatIdVerification,
            tradeRegisterNo: a.tradeRegisterNo,
            phone: a.phone,
            street: a.street,
            postalCode: a.postalCode,
            countyName: a.countyName,
            localityName: a.localityName,
            country: a.country,
          }))
      : null,
    customerNote: viewer.pii ? order.customerNote : null,
    installation: {
      requested: order.installationRequested,
      note: viewer.pii ? order.installationNote : null,
      status: order.installationStatus,
    },
    consent: { acceptedAt: order.termsAcceptedAt, version: order.termsConsentVersion },
    supplier:
      order.supplierMarkedAt && order.supplierMarkedBy
        ? {
            markedAt: order.supplierMarkedAt,
            markedBy: order.supplierMarkedBy,
            name: order.supplierName,
            note: order.supplierNote,
          }
        : null,
    reservationExpiresAt: order.reservationExpiresAt,
    paymentRetryDeadlineAt: order.paymentRetryDeadlineAt,
    events: order.events.map((e) => ({
      id: e.id,
      type: e.type,
      message: e.message,
      actorLabel: e.actorLabel,
      createdAt: e.createdAt,
    })),
    notes,
    payments: viewer.payments
      ? payments.map((p) => ({
          id: p.id,
          attemptNo: p.attemptNo,
          provider: p.provider,
          method: p.method,
          mode: p.mode,
          status: p.status,
          amountMinor: p.amountMinor,
          capturedAmountMinor: p.capturedAmountMinor,
          refundCommittedMinor: p.refundCommittedMinor,
          cardLast4: p.cardLast4,
          attentionReason:
            p.attentionReason && !p.attentionResolvedAt
              ? (p.attentionReason as AttentionReason)
              : null,
          createdAt: p.createdAt,
          capturedAt: p.capturedAt,
          refunds: p.refunds.map((r) => ({
            id: r.id,
            amountMinor: r.amountMinor,
            status: r.status,
            kind: r.kind,
            reason: r.reason,
            manualReference: r.manualReference,
            failureMessage: r.failureMessage,
            actorLabel: r.actorLabel,
            limitedActor: r.limitedActor,
            createdAt: r.createdAt,
            confirmedAt: r.confirmedAt,
          })),
        }))
      : null,
    refundable:
      primary && primary.status === "paid"
        ? {
            paymentId: primary.id,
            remainingMinor: Math.max(primary.amountMinor - primary.refundCommittedMinor, 0),
          }
        : null,
    needsRefund,
    emails: emails
      ? emails.map((e) => ({
          id: e.id,
          template: e.template,
          audience: e.audience,
          recipient: e.recipient,
          status: e.status,
          attempts: e.attempts,
          lastError: e.lastError,
          createdAt: e.createdAt,
          sentAt: e.sentAt,
        }))
      : null,
  };
}
