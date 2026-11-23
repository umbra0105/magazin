import { DomainError } from "@ecom/shared";

export const INVOICE_SERVICE_CODES = [
  "INVOICE_NOT_FOUND",
  "INVOICE_STATE_INVALID",
  "INVOICE_NO_PROVIDER",
  "INVOICE_ORDER_NOT_ELIGIBLE",
  "INVOICE_OUTCOME_UNKNOWN",
  "INVOICE_PARENT_UNRESOLVED",
] as const;

export class InvoiceServiceError extends DomainError {
  constructor(code: (typeof INVOICE_SERVICE_CODES)[number], message: string, details?: unknown) {
    super(code, message, details);
  }
}
