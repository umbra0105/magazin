import {
  STOCK_SYNC_ALERT_TEMPLATE,
  formatCompanyAddress,
  getOrderSummary,
  isInvoiceAlertRecipient,
  isStockAlertRecipient,
  INVOICE_ALERT_TEMPLATE,
  issueRetryTokenFor,
  type DispatchRow,
  type Db,
  type OrderSummary,
} from "@ecom/core";
import { formatQuantityWithUnit, quantityFromTicks } from "@ecom/shared";
import type {
  MerchantModel,
  OrderEmailModel,
  TemplateContext,
  TemplateDefinition,
} from "@ecom/emails";
import { templateDefinition } from "@ecom/emails";

/**
 * Construiește contextul unui email de comandă din baza de date, în momentul trimiterii (nu al punerii în coadă): datele
 * personale nu stau în coadă, iar emailul reflectă starea de acum a comenzii. Ridicarea personală folosește DOAR adresa
 * magazinului salvată în snapshot (`OrderSummary.shipping.pickupAddressText`), niciodată rândul `Address` de tip shipping, care
 * e adresa CLIENTULUI (decizia 2026-11-19, punctul e).
 */
export interface StoreEmailSettings {
  storeName: string;
  currency: string;
  locale: string;
  timeZone: string;
  company: {
    legalName: string;
    vatId: string;
    tradeRegisterNo: string;
    address: {
      street: string;
      city: string;
      county: string;
      postalCode: string;
      country: string;
    };
    email: string;
    phone: string;
    iban: string;
    bankName: string;
  };
  legal: { anpcUrl: string; salUrl: string; odrUrl: string };
}

export interface OrderEmailContextEnv {
  db: Db;
  appUrl: string;
  now: () => Date;
  store: StoreEmailSettings;
}

export type OrderEmailContextResult =
  | { kind: "ready"; definition: TemplateDefinition; to: string; context: TemplateContext }
  | { kind: "skip"; reason: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const origin = (appUrl: string): string => new URL(appUrl).origin;

const METHOD_LABELS: Record<string, string> = {
  cod: "Ramburs",
  bank_transfer: "Transfer bancar",
  card: "Card online",
};

export function formatMoney(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

export function formatDateTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function daysText(days: number): string {
  return days === 1 ? "1 zi" : days < 20 ? `${days} zile` : `${days} de zile`;
}

export function merchantOf(store: StoreEmailSettings): MerchantModel {
  return {
    name: store.storeName,
    legalName: store.company.legalName,
    vatId: store.company.vatId,
    tradeRegisterNo: store.company.tradeRegisterNo,
    address:
      store.company.address.street.trim() !== "" || store.company.address.city.trim() !== ""
        ? formatCompanyAddress(store.company.address)
        : "",
    phone: store.company.phone,
    email: store.company.email,
    iban: store.company.iban,
    bankName: store.company.bankName,
  };
}

function orderModelOf(summary: OrderSummary, store: StoreEmailSettings): OrderEmailModel {
  const money = (minor: number) => formatMoney(minor, store.currency, store.locale);
  const pickup = summary.shipping.kind === "pickup";
  // transport paletizat (decizia 2026-11-22): rambursul rămâne, dar transportatorul nu acceptă numerar
  const pallet = summary.shipping.kind === "pallet";
  const method = (
    ["cod", "bank_transfer", "card"].includes(summary.paymentMethod) ? summary.paymentMethod : "cod"
  ) as "cod" | "bank_transfer" | "card";
  const hasOnOrder = summary.lines.some((line) => line.stockState === "on_order");
  const term = summary.longestLeadTimeDays;
  const estimated = summary.shipping.estimatedDays;
  return {
    number: summary.number,
    placedAt: formatDateTime(summary.placedAt, store.locale, store.timeZone),
    lines: summary.lines.map((line) => ({
      title: line.title,
      detail: line.variantTitle,
      quantity: formatQuantityWithUnit(
        quantityFromTicks(BigInt(line.quantityTicks)),
        line.unitSymbol,
      ),
      amount: money(line.lineTotalMinor),
    })),
    totals: {
      products: money(summary.totals.subtotalMinor),
      shipping:
        summary.totals.shippingMinor === 0 ? "Gratuit" : money(summary.totals.shippingMinor),
      codFee: summary.totals.codFeeMinor > 0 ? money(summary.totals.codFeeMinor) : null,
      vat: money(summary.totals.taxMinor),
      total: money(summary.totals.totalMinor),
    },
    payment: {
      method,
      methodLabel:
        pickup && method === "cod"
          ? "Ramburs (în magazin, la ridicare)"
          : (METHOD_LABELS[method] ?? method),
      note:
        method === "cod"
          ? pickup
            ? "Plătești în magazin la ridicare"
            : pallet
              ? "Plata la livrare doar cu cardul; curierul nu acceptă numerar"
              : "Plătești curierului la primirea coletului"
          : null,
    },
    delivery: pickup
      ? {
          kind: "pickup",
          heading: "Ridicare personală de la",
          // adresa MAGAZINULUI din snapshot; fără ea, doar eticheta (niciodată adresa clientului)
          text: summary.shipping.pickupAddressText ?? "adresa magazinului",
          termText: null,
          // programul de ridicare, doar când e completat în setări (se citește la trimitere, nu din snapshot)
          pickupHoursText: summary.shipping.pickupHoursText,
        }
      : {
          kind: "courier",
          heading: "Livrare în",
          text: summary.destination
            ? `${summary.destination.localityName}, ${summary.destination.countyName}`
            : "adresa indicată de tine",
          termText:
            term !== null
              ? `aproximativ ${daysText(term)} (toată comanda odată, cel mai lung termen)`
              : estimated !== null && estimated > 0
                ? `aproximativ ${daysText(estimated)}`
                : null,
        },
    hasOnOrderLines: hasOnOrder,
  };
}

const REASON_AUTO: Record<string, string> = {
  bank_transfer: "Termenul de plată prin transfer bancar a expirat",
  card: "Fereastra de plată cu cardul a expirat",
  cod: "Comanda nu a mai putut fi onorată",
};

export async function buildOrderEmailContext(
  env: OrderEmailContextEnv,
  dispatch: DispatchRow,
): Promise<OrderEmailContextResult> {
  const definition = templateDefinition(dispatch.template);
  if (!definition) return { kind: "skip", reason: "șablon necunoscut" };
  const store = env.store;
  const data = asRecord(dispatch.data);
  const base = origin(env.appUrl);
  const money = (minor: number) => formatMoney(minor, store.currency, store.locale);
  const merchant = merchantOf(store);
  const legal = store.legal;

  // --- notificări interne fără comandă (nu se citește nicio comandă) ---
  if (!dispatch.orderId) {
    // alerta de stoc: destinatarul se REVERIFICĂ la trimitere (rol retras, email schimbat în neverificat între timp)
    if (dispatch.template === STOCK_SYNC_ALERT_TEMPLATE) {
      if (!(await isStockAlertRecipient(env.db, dispatch.recipient))) {
        return { kind: "skip", reason: "destinatarul nu mai are drept la alerta de stoc" };
      }
      const takenAt = typeof data["takenAt"] === "string" ? new Date(data["takenAt"]) : null;
      return {
        kind: "ready",
        definition,
        to: dispatch.recipient,
        context: {
          vars: {
            magazin: store.storeName,
            ultima:
              takenAt && !Number.isNaN(takenAt.getTime())
                ? formatDateTime(takenAt, store.locale, store.timeZone)
                : "niciodată",
            linkAdmin: `${base}/admin/produse/stoc`,
          },
          merchant,
          legal,
          order: null,
        },
      };
    }
    return {
      kind: "ready",
      definition,
      to: dispatch.recipient,
      context: {
        vars: { magazin: store.storeName, linkAdmin: `${base}/admin/produse/stoc` },
        merchant,
        legal,
        order: null,
      },
    };
  }

  // alerta de facturare: destinatarul se REVERIFICĂ la trimitere (rol retras, email schimbat între timp)
  if (dispatch.template === INVOICE_ALERT_TEMPLATE) {
    if (!(await isInvoiceAlertRecipient(env.db, dispatch.recipient))) {
      return { kind: "skip", reason: "destinatarul nu mai are drept la alerta de facturare" };
    }
  }
  const order = await env.db.order.findUnique({
    where: { id: dispatch.orderId },
    select: {
      id: true,
      email: true,
      paymentRetryDeadlineAt: true,
      reservationExpiresAt: true,
      installationNote: true,
      addresses: { where: { kind: "billing" }, select: { fullName: true } },
    },
  });
  if (!order) return { kind: "skip", reason: "comanda nu mai există" };
  const summary = await getOrderSummary(env.db, order.id);
  if (!summary) return { kind: "skip", reason: "comanda nu mai există" };

  const client = order.addresses[0]?.fullName ?? "";
  const vars: Record<string, string> = {
    magazin: store.storeName,
    client,
    numar: summary.number,
    total: money(summary.totals.totalMinor),
    link: `${base}/comanda/urmarire`,
    metodaPlata: METHOD_LABELS[summary.paymentMethod] ?? summary.paymentMethod,
    linkAdmin: `${base}/admin/comenzi/${order.id}`,
    nota: order.installationNote?.trim() || "nespecificate",
  };

  switch (dispatch.template) {
    case "order.proforma":
      vars["termen"] = order.reservationExpiresAt
        ? formatDateTime(order.reservationExpiresAt, store.locale, store.timeZone)
        : "";
      break;
    case "order.payment_failed": {
      try {
        const issued = await issueRetryTokenFor({ db: env.db, now: env.now }, order.id);
        vars["linkPlata"] = `${base}/comanda/plateste/${issued.token}`;
        vars["termen"] = formatDateTime(issued.expiresAt, store.locale, store.timeZone);
      } catch {
        // fereastra de reîncercare a expirat sau comanda nu mai așteaptă plata: un email cu link mort ar induce în eroare
        return { kind: "skip", reason: "plata nu mai poate fi reîncercată" };
      }
      break;
    }
    case "order.cancelled": {
      const reason = typeof data["reason"] === "string" ? data["reason"] : "";
      vars["motiv"] =
        reason === "auto"
          ? (REASON_AUTO[summary.paymentMethod] ?? "Comanda a fost anulată automat")
          : reason.trim() !== ""
            ? reason.trim()
            : "Comanda a fost anulată";
      vars["notaPlata"] =
        data["paid"] === true
          ? "Ai plătit această comandă: te anunțăm printr-un email separat când rambursarea este confirmată."
          : "";
      break;
    }
    case "order.refunded":
      vars["suma"] = typeof data["amountMinor"] === "number" ? money(data["amountMinor"]) : "";
      break;
    case "order.shipped":
      vars["awb"] = typeof data["awb"] === "string" ? data["awb"] : "";
      vars["curier"] = typeof data["carrier"] === "string" ? data["carrier"] : "";
      break;
    case "return.received":
    case "return.approved":
    case "return.awb":
    case "return.rejected":
    case "return.parcel_received":
    case "return.inspected":
    case "return.refunded":
    case "return.cancelled": {
      // doar câmpurile destinate clientului: motivul respingerii, AWB-ul de retur, suma rambursată; NICIODATĂ nota internă
      const returnId = typeof data["returnId"] === "string" ? data["returnId"] : "";
      const ret = returnId
        ? await env.db.returnRequest.findFirst({
            where: { id: returnId, orderId: order.id },
            select: {
              id: true,
              number: true,
              rejectReason: true,
              returnCarrier: true,
              returnAwb: true,
              returnTrackingUrl: true,
              refundProductsMinor: true,
              refundShippingMinor: true,
            },
          })
        : null;
      if (!ret) return { kind: "skip", reason: "returul nu mai există" };
      vars["retur"] = `R-${ret.number}`;
      vars["motiv"] = ret.rejectReason?.trim() ?? "";
      vars["awb"] = ret.returnAwb ?? "";
      vars["curier"] = ret.returnCarrier ?? "";
      vars["linkUrmarire"] = ret.returnTrackingUrl ?? "";
      vars["suma"] =
        ret.refundProductsMinor === null
          ? ""
          : money(ret.refundProductsMinor + ret.refundShippingMinor);
      vars["adresaRetur"] = merchant.address;
      vars["link"] = `${base}/cont/retururi/${ret.id}`;
      break;
    }
    case "internal.invoice_failed":
      vars["motiv"] = typeof data["reason"] === "string" ? data["reason"] : "";
      break;
    case "internal.stock_out": {
      const variantId = typeof data["variantId"] === "string" ? data["variantId"] : "";
      const variant = variantId
        ? await env.db.productVariant.findUnique({
            where: { id: variantId },
            select: { sku: true, product: { select: { title: true } } },
          })
        : null;
      if (!variant) return { kind: "skip", reason: "varianta nu mai există" };
      vars["produs"] = variant.product.title;
      vars["sku"] = variant.sku;
      vars["linkAdmin"] = `${base}/admin/produse/stoc`;
      break;
    }
    default:
      break;
  }

  return {
    kind: "ready",
    definition,
    to: dispatch.recipient,
    context: { vars, merchant, legal, order: orderModelOf(summary, store) },
  };
}
