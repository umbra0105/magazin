import { DomainError } from "@ecom/shared";

export const LOYALTY_ERROR_CODES = [
  "LOYALTY_INSUFFICIENT_POINTS",
  "LOYALTY_RELEASE_INVALID",
  "LOYALTY_ADJUST_INVALID",
  "LOYALTY_INVALID_POINTS",
] as const;
export type LoyaltyErrorCode = (typeof LOYALTY_ERROR_CODES)[number];

export class LoyaltyError extends DomainError {
  constructor(code: LoyaltyErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
