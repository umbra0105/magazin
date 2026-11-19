import type { CardPaymentView } from "@ecom/core";
import { formatDateTime } from "./format-date";

export interface PaymentStateDto {
  state: "checking" | "paid" | "failed" | "cancelled" | "stock_lost" | "attention";
  canRetry: boolean;
  orderNumber: string;
  /** Până când se poate reîncerca (text în ora magazinului), sau `null`. */
  retryUntilText: string | null;
  pendingSeconds: number | null;
}

/** Starea plății pentru pagini (client): doar text și valori simple, fără ID-uri interne. */
export function toPaymentStateDto(
  view: CardPaymentView,
  regional: { locale: string; timezone: string },
): PaymentStateDto {
  return {
    state: view.state,
    canRetry: view.canRetry,
    orderNumber: view.orderNumber,
    pendingSeconds: view.pendingSeconds,
    retryUntilText: view.retryDeadlineAt
      ? formatDateTime(view.retryDeadlineAt, regional.locale, regional.timezone)
      : null,
  };
}
