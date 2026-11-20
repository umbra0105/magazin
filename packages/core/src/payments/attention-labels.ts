import type { AttentionReason } from "./payment-errors";

/**
 * Etichetele scurte, în română, ale motivelor «necesită atenție» (linia de context a notificării din clopoțel). Aceleași texte ca în
 * ecranul plăților (`apps/web/src/messages/admin-orders-ro.ts`, `detail.payment.attention`); un test din aplicație păstrează
 * cele două liste identice. Fără date personale: doar motivul.
 */
export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  amount_mismatch: "Suma diferă de total",
  currency_mismatch: "Monedă diferită",
  stock_reservation_lost: "Plată după expirarea rezervării",
  late_payment_cancelled_order: "Plată pe comandă anulată",
  duplicate_payment: "Plată dublă",
  refund_manual_required: "Rambursare manuală necesară",
  refund_failed: "Rambursare refuzată",
  unknown_status: "Stare necunoscută",
  unexpected_order_state: "Stare neașteptată a comenzii",
  reconciliation_mismatch: "Diferență la reconciliere",
  credit_unmatched: "Credit fără rambursare",
  order_cancelled_paid: "Comandă anulată, plată încasată",
};
