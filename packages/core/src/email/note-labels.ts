/**
 * Etichetele scurte ale șabloanelor de email, pentru linia de context a notificării «Un email a rămas netrimis» (Faza 11). Aceleași
 * texte ca în catalogul de șabloane (`packages/emails/src/catalog.ts`, câmpul `label`); `core` nu depinde de pachetul de emailuri,
 * deci un test din `packages/jobs` (care vede ambele) le ține identice. Un șablon necunoscut primește eticheta generică.
 */
export const EMAIL_NOTE_LABELS: Readonly<Record<string, string>> = {
  "order.confirmation": "Confirmare comandă",
  "order.proforma": "Proformă (transfer bancar)",
  "order.payment_received": "Plată primită",
  "order.payment_failed": "Plată eșuată",
  "order.processing": "Comandă în procesare",
  "order.shipped": "Comandă expediată",
  "order.delivered": "Comandă livrată",
  "order.cancelled": "Comandă anulată",
  "order.refunded": "Rambursare confirmată",
  "order.stock_lost": "Plată primită după expirarea rezervării",
  "offer.payment_link": "Oferta de plată: linkul către client",
  "internal.order_new": "Notificare internă: comandă nouă",
  "internal.stock_out": "Notificare internă: stoc epuizat",
  "internal.installation_request": "Notificare internă: cerere de instalare",
  "internal.stock_sync_stale": "Alertă internă: sincronizarea SmartBill e neactualizată",
};

export const emailNoteLabel = (template: string): string =>
  EMAIL_NOTE_LABELS[template] ?? "Email netrimis";
