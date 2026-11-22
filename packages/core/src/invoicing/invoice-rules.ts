/**
 * Când se emite fiecare document fiscal (docs/10, Partea I; Faza 13). Funcții PURE: aceleași reguli sunt apelate la scrierea în
 * outbox (în tranzacția evenimentului de comandă) și în teste.
 *
 *  - card: factura la PLATA CONFIRMATĂ;
 *  - transfer bancar: PROFORMA la plasare; factura după ce adminul confirmă plata («Marchează plătit»);
 *  - ramburs: factura la PLASAREA comenzii (cu storno dacă se întoarce); excepție «La comandă» (neprevăzută la ramburs, regula
 *    de plată o interzice, dar tratată): factura la EXPEDIERE;
 *  - «La comandă» plătit în avans: la plată, ca orice comandă plătită;
 *  - anulare după emitere / refuz de ramburs / rambursare TOTALĂ: STORNO total; anulare cu doar proformă: proforma se anulează;
 *    anulare cu documentul încă în coadă: nu se mai emite.
 * O rambursare PARȚIALĂ de bani nu stornează nimic (documentul la rambursarea parțială = întrebarea #14 din INTREBARI-CONTABIL,
 * 🟡): stornoul parțial se cere explicit, pe produse (retur parțial, Faza 14).
 */
export type InvoicePaymentMethod = "cod" | "bank_transfer" | "card";

export interface InvoiceOrderFacts {
  paymentMethod: InvoicePaymentMethod;
  paymentStatus: string;
  /** Comanda vine de pe un canal extern (eMAG): facturarea ei nu e a magazinului. */
  external: boolean;
  /** Cel puțin o linie e «La comandă» (fără stoc propriu). */
  hasOnOrderLine: boolean;
}

export type InvoiceAction =
  { action: "issue"; kind: "proforma" | "invoice" } | { action: "reverse" };

/** Evenimentele de comandă la care facturarea are ceva de făcut (pentru teste și documentație). */
export const INVOICE_TRIGGER_EVENT_TYPES: readonly string[] = [
  "order.placed",
  "payment.confirmed",
  "order.shipped",
  "order.cancelled",
  "order.auto_cancelled",
  "order.returned_to_sender",
  "payment.refunded",
];

export function invoiceActionsFor(eventType: string, facts: InvoiceOrderFacts): InvoiceAction[] {
  if (facts.external) return [];
  switch (eventType) {
    case "order.placed":
      if (facts.paymentMethod === "bank_transfer") return [{ action: "issue", kind: "proforma" }];
      if (facts.paymentMethod === "cod" && !facts.hasOnOrderLine) {
        return [{ action: "issue", kind: "invoice" }];
      }
      return [];
    case "payment.confirmed":
      // card și transfer: plata confirmată. La ramburs, confirmarea e încasarea de la curier, dar factura s-a emis deja.
      return facts.paymentMethod === "cod" ? [] : [{ action: "issue", kind: "invoice" }];
    case "order.shipped":
      return facts.paymentMethod === "cod" && facts.hasOnOrderLine
        ? [{ action: "issue", kind: "invoice" }]
        : [];
    case "order.cancelled":
    case "order.auto_cancelled":
    case "order.returned_to_sender":
      return [{ action: "reverse" }];
    case "payment.refunded":
      // doar rambursarea TOTALĂ (după tranziție, plata comenzii e «refunded»)
      return facts.paymentStatus === "refunded" ? [{ action: "reverse" }] : [];
    default:
      return [];
  }
}

/** Tipul de încasare trecut pe factură la emitere (SmartBill: lista fixă de tipuri), după metoda de plată; ramburs: neîncasat încă. */
export function invoicePaymentType(
  method: InvoicePaymentMethod,
): "Card online" | "Ordin plata" | null {
  if (method === "card") return "Card online";
  if (method === "bank_transfer") return "Ordin plata";
  return null;
}
