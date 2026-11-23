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
  /** Anularea: motiv lipsă sau prea lung, comandă care nu mai poate fi anulată (încheiată, expediată). */
  "ORDER_CANCEL_INVALID",
  /** Anularea unei comenzi plătite cere decizia explicită «NU se rambursează automat». */
  "ORDER_CANCEL_PAID_NEEDS_DECISION",
  "ORDER_PROCESSING_INVALID",
  /** «Marchează ridicată»: comanda nu are ridicare personală sau starea ei nu permite ridicarea. */
  "ORDER_PICKUP_INVALID",
  /** Corectarea contactului sau a adresei: date invalide sau comandă care nu se mai editează. */
  "ORDER_EDIT_INVALID",
  "ORDER_NOTE_INVALID",
  /** «Marchează plătit» (transfer): suma primită diferă de total (fără decizie explicită), sumă sau referință invalide. */
  "ORDER_PAYMENT_AMOUNT_MISMATCH",
  "ORDER_PAYMENT_AMOUNT_INVALID",
  "ORDER_PAYMENT_REFERENCE_INVALID",
  /** «Marchează încasat» (ramburs): data virării în viitor sau înaintea plasării comenzii. */
  "ORDER_PAYMENT_DATE_INVALID",
  /** Vederile salvate: nume sau filtre invalide, nume duplicat, limită atinsă, vedere inexistentă. */
  "ORDER_VIEW_INVALID",
  "ORDER_VIEW_DUPLICATE",
  "ORDER_VIEW_LIMIT",
  "ORDER_VIEW_NOT_FOUND",
  /** Cererea de instalare: comanda nu are cerere sau starea nu e validă. */
  "ORDER_INSTALLATION_INVALID",
] as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[number];

export class OrderError extends DomainError {
  constructor(code: OrderErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
