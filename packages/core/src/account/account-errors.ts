import { DomainError } from "@ecom/shared";

/** Codurile stabile ale refuzurilor din contul clientului (interfața le traduce în mesaje în română). */
export const ACCOUNT_ERROR_CODES = [
  /** Adresa nu există sau nu e a clientului (aceleași răspuns în ambele cazuri). */
  "ACCOUNT_ADDRESS_NOT_FOUND",
  "ACCOUNT_ADDRESS_LIMIT",
  "ACCOUNT_ADDRESS_INVALID",
  "ACCOUNT_PROFILE_INVALID",
  "ACCOUNT_ORDER_NOT_FOUND",
  /** Ștergerea contului e refuzată: comenzi nefinalizate sau retur deschis. */
  "ACCOUNT_DELETE_BLOCKED",
  "WISHLIST_VARIANT_NOT_FOUND",
  "WISHLIST_LIMIT",
] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

export class AccountError extends DomainError {
  constructor(code: AccountErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
