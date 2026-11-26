import { formatQuantity, quantityFromTicks } from "@ecom/shared";
import { isUncertainInvoiceCode, type InvoiceDetailDto, type InvoiceDto } from "@ecom/core";
import type { InvoiceDocDto } from "@/components/admin/invoicing/invoice-panel";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";

/** Formatul de afișare al magazinului (ora și moneda din setări), pentru documentele fiscale. */
export interface InvoiceFormat {
  currency: string;
  locale: string;
  timezone: string;
}

/** Documentul pentru interfață: sume și date deja formatate pe server, fără nicio dată personală a clientului. */
export function toInvoiceDocDto(
  doc: InvoiceDto | InvoiceDetailDto,
  format: InvoiceFormat,
): InvoiceDocDto {
  const money = (minor: number): string => formatMoney(minor, format.currency, format.locale);
  const when = (date: Date): string => formatDateTime(date, format.locale, format.timezone);
  const detail = "events" in doc ? doc : null;
  return {
    id: doc.id,
    orderId: doc.orderId,
    kind: doc.kind,
    docKey: doc.docKey,
    status: doc.status,
    reference: doc.series && doc.number ? `${doc.series} ${doc.number}` : null,
    simulated: doc.simulated,
    efacturaStatus: doc.efacturaStatus,
    totalText: money(doc.totalMinor),
    taxText: money(doc.taxMinor),
    useStock: doc.useStock,
    attempts: doc.attempts,
    whenText: when(doc.issuedAt ?? doc.createdAt),
    nextAttemptText: doc.nextAttemptAt ? when(doc.nextAttemptAt) : null,
    lastError: doc.status === "issued" && doc.lastErrorCode === null ? null : doc.lastError,
    lastErrorCode: doc.lastErrorCode,
    uncertain: isUncertainInvoiceCode(doc.lastErrorCode),
    events: (detail?.events ?? []).map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      whenText: when(event.createdAt),
    })),
    lines: (detail?.lines ?? []).map((line) => ({
      position: line.position,
      title: line.title,
      kind: line.kind,
      quantityText: formatQuantity(quantityFromTicks(line.quantityTicks), { maxDecimals: 2 }),
      unitName: line.unitName,
      // rândul de reducere din puncte se păstrează cu sume pozitive; semnul îl dă tipul
      totalText: money(line.kind === "discount" ? -line.lineTotalMinor : line.lineTotalMinor),
      taxText: money(line.kind === "discount" ? -line.taxMinor : line.taxMinor),
    })),
  };
}
