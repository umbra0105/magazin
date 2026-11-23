/**
 * Retururile (Faza 14): valori fixe. Textele pentru oameni (etichetele motivelor, ale stărilor, ale mesajelor) stau în mesajele
 * aplicației, nu aici: codurile sunt stabile, textele se pot schimba.
 */

export const RETURN_STATUSES = [
  "requested",
  "approved",
  "awaiting_shipment",
  "received",
  "inspected",
  "refunded",
  "rejected",
  "cancelled",
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Motivele din listă (cod stabil). «other» cere text. */
export const RETURN_REASON_CODES = [
  "changed_mind",
  "defective",
  "not_as_described",
  "wrong_item",
  "damaged_in_transit",
  "other",
] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

/** Starea constatată la inspecție. */
export const RETURN_CONDITIONS = [
  "as_new",
  "opened",
  "damaged",
  "defective",
  "wrong_item",
] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/** Cum trimite clientul coletul: cu un curier (adminul îi dă AWB-ul sau instrucțiunile) sau îl aduce la sediu. */
export const RETURN_SEND_MODES = ["courier", "drop_off"] as const;
export type ReturnSendMode = (typeof RETURN_SEND_MODES)[number];

export const RETURN_STORNO_STATES = ["queued", "covered_by_total", "not_needed", "failed"] as const;
export type ReturnStornoState = (typeof RETURN_STORNO_STATES)[number];

/** Cheia de idempotență a rambursării unui retur în serviciul din Faza 10: `return:<id>`. */
export const RETURN_REFUND_KEY_PREFIX = "return:";
export const returnRefundKey = (returnId: string): string =>
  `${RETURN_REFUND_KEY_PREFIX}${returnId}`;

export const RETURN_NOTE_MAX = 1000;
export const RETURN_REASON_TEXT_MAX = 500;
export const RETURN_REJECT_REASON_MAX = 500;
export const RETURN_ADMIN_NOTE_MAX = 1000;
export const RETURN_CARRIER_MAX = 80;
export const RETURN_AWB_MAX = 60;
export const RETURN_TRACKING_URL_MAX = 300;
export const RETURN_SHIPPING_REASON_MAX = 300;
export const RETURN_CLIENT_KEY_MAX = 80;

/**
 * Evenimentele de retur pe care le vede clientul în cronologia din cont (lista albă). Orice alt tip rămâne intern. Notele interne
 * (`adminNote`) nu intră niciodată în `message` al unui eveniment vizibil.
 */
export const RETURN_CUSTOMER_EVENT_TYPES: readonly string[] = [
  "return.requested",
  "return.approved",
  "return.awb_set",
  "return.awaiting_shipment",
  "return.received",
  "return.inspected",
  "return.refunded",
  "return.rejected",
  "return.cancelled",
];

export const isCustomerVisibleReturnEvent = (type: string): boolean =>
  RETURN_CUSTOMER_EVENT_TYPES.includes(type);

/** Stările în care returul mai poate fi anulat de client. */
export const CUSTOMER_CANCELLABLE_STATUSES: readonly ReturnStatus[] = ["requested", "approved"];

/** Retururile deschise: împiedică ștergerea contului. */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = [
  "requested",
  "approved",
  "awaiting_shipment",
  "received",
  "inspected",
];
