import { DomainError } from "@ecom/shared";

/** Codurile stabile ale erorilor din zona plăților (Faza 10); interfața le traduce în mesaje în română. */
export const PAYMENT_ERROR_CODES = [
  "PAYMENT_NOT_FOUND",
  "PAYMENT_NOT_REFUNDABLE",
  "REFUND_EXCEEDS_PAID",
  "REFUND_NOT_FOUND",
  "REFUND_NOT_MANUAL",
  "REFUND_INVALID",
  /** Rolul Suport: suma cerută plus ce s-a rambursat deja cu limită pe comandă depășește `payment.supportRefundLimit`. */
  "REFUND_OVER_LIMIT",
  /** Actor cu limită, dar limita din setare lipsește sau nu se poate citi: refuz (niciodată «fără limită»). */
  "REFUND_LIMIT_UNAVAILABLE",
  "PAYMENT_RETRY_UNAVAILABLE",
  "PAYMENT_RETRY_EXPIRED",
  "PAYMENT_RETRY_NO_STOCK",
  "PAYMENT_CARD_UNAVAILABLE",
  "PAYMENT_INITIATION_FAILED",
] as const;
export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];

export class PaymentError extends DomainError {
  constructor(code: PaymentErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}

/** Motivele stabile ale stării «necesită atenție» a unei plăți. */
export const ATTENTION_REASONS = [
  /** Suma raportată de procesator ≠ totalul comenzii (sau suma lipsește): NU se confirmă, NU se rambursează automat. */
  "amount_mismatch",
  /** Moneda raportată de procesator ≠ RON: tratată la fel. */
  "currency_mismatch",
  /** Plată confirmată după ce rezervarea a expirat și stocul s-a luat: rambursare automată + comanda anulată. */
  "stock_reservation_lost",
  /** Plată confirmată pe o comandă deja anulată: rambursare automată. */
  "late_payment_cancelled_order",
  /** A doua plată confirmată pentru aceeași comandă: rambursare automată. */
  "duplicate_payment",
  /** Rambursarea automată sau manuală nu s-a putut face prin API: se face din contul procesatorului. */
  "refund_manual_required",
  "refund_failed",
  /** Stare necunoscută raportată de procesator. */
  "unknown_status",
  /** Comanda sau plata sunt într-o stare care nu permite confirmarea. */
  "unexpected_order_state",
  /** Reconcilierea a găsit o diferență care nu se poate repara sigur. */
  "reconciliation_mismatch",
  /** Notificare de credit (rambursare) fără rambursare corespunzătoare la noi. */
  "credit_unmatched",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];
