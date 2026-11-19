import { DomainError } from "@ecom/shared";

/** Codurile stabile ale refuzurilor de la checkout și de la plasarea comenzii (interfața le traduce în mesaje în română). */
export const ORDER_ERROR_CODES = [
  "ORDER_GUEST_CHECKOUT_DISABLED",
  "ORDER_CART_NOT_READY",
  "ORDER_CART_CHANGED",
  "ORDER_TOTAL_CHANGED",
  "ORDER_DIGITAL_NOT_SUPPORTED",
  "ORDER_COUNTRY_NOT_ALLOWED",
  "ORDER_OFFER_UNAVAILABLE",
  "ORDER_QUANTITY_INVALID",
  "ORDER_CUI_INVALID",
  "ORDER_BANK_DETAILS_MISSING",
  "ORDER_NOT_FOUND",
  "ORDER_PAYMENT_NOT_PENDING",
  "ORDER_RESERVATION_EXPIRED",
  "ORDER_CARD_UNAVAILABLE",
  /** Marcajul «La furnizor»: comandă care nu mai e activă sau text prea lung. */
  "ORDER_SUPPLIER_MARK_INVALID",
] as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[number];

export class OrderError extends DomainError {
  constructor(code: OrderErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
