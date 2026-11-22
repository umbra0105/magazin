import { DomainError } from "@ecom/shared";

/** Codurile stabile ale refuzurilor din fluxul de retur (interfața le traduce în mesaje în română). */
export const RETURN_ERROR_CODES = [
  "RETURN_NOT_FOUND",
  /** Comanda nu are o livrare consemnată sau nu e a clientului. */
  "RETURN_ORDER_NOT_ELIGIBLE",
  "RETURN_WINDOW_EXPIRED",
  "RETURN_NOTHING_RETURNABLE",
  "RETURN_INPUT_INVALID",
  "RETURN_QUANTITY_INVALID",
  "RETURN_QUANTITY_EXCEEDED",
  "RETURN_STATE_INVALID",
  "RETURN_AWB_INVALID",
  "RETURN_INSPECTION_INVALID",
  /** Rambursarea: starea sau suma nu permit cererea. */
  "RETURN_REFUND_INVALID",
  /** Comanda are o rambursare de retur în așteptare: o a doua nu poate porni până nu se încheie. */
  "RETURN_REFUND_PENDING_OTHER",
  /** Furnizorul de facturare e activ, dar comanda nu are o factură emisă. */
  "RETURN_REFUND_INVOICE_PENDING",
  /** Rambursarea ar completa suma plătită după stornouri parțiale (storno total ar dubla). */
  "RETURN_REFUND_COMPLETES_ORDER",
  "RETURN_RESTOCK_INVALID",
] as const;
export type ReturnErrorCode = (typeof RETURN_ERROR_CODES)[number];

export class ReturnError extends DomainError {
  constructor(code: ReturnErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
