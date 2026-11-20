/**
 * Tonul pastilei pentru starea unei comenzi, a plății sau a livrării (docs/17 §2.2). Textul stării se scrie mereu; tonul e doar un
 * ajutor. Un singur loc pentru listă, panou lateral și detaliu.
 */
export type OrderTone = "neutral" | "info" | "success" | "warning" | "danger";

export const ORDER_STATUS_TONE: Record<string, OrderTone> = {
  draft: "neutral",
  pending: "warning",
  confirmed: "info",
  processing: "info",
  completed: "success",
  cancelled: "neutral",
  returned: "danger",
};

export const PAYMENT_STATUS_TONE: Record<string, OrderTone> = {
  pending: "warning",
  authorized: "info",
  paid: "success",
  partially_refunded: "info",
  refunded: "info",
  failed: "danger",
  cancelled: "neutral",
  chargeback: "danger",
};

export const FULFILLMENT_STATUS_TONE: Record<string, OrderTone> = {
  unfulfilled: "neutral",
  partially_fulfilled: "info",
  fulfilled: "info",
  in_transit: "info",
  delivered: "success",
  returned: "danger",
  cancelled: "neutral",
};

export const EMAIL_STATUS_TONE: Record<string, OrderTone> = {
  queued: "warning",
  sending: "info",
  sent: "success",
  failed: "danger",
  skipped: "neutral",
};
