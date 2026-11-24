import { DomainError } from "@ecom/shared";

/**
 * Erorile produselor digitale (Faza 14b), cu cod stabil. Mesajele sunt în română, fără chei de stocare, fără secrete și fără
 * date ale altor clienți. «Nu există» și «nu e al tău» au ACELAȘI cod (`DIGITAL_NOT_FOUND`): clientul nu află dacă un jeton aparține
 * altcuiva.
 */
export const DIGITAL_ERROR_CODES = [
  "DIGITAL_NOT_FOUND",
  "DIGITAL_REVOKED",
  "DIGITAL_EXPIRED",
  "DIGITAL_LIMIT_REACHED",
  "DIGITAL_ASSET_UNAVAILABLE",
  "DIGITAL_INPUT_INVALID",
  "DIGITAL_PROVIDER_UNAVAILABLE",
  "DIGITAL_NOT_DIGITAL_PRODUCT",
  "DIGITAL_UPLOAD_REFUSED",
  "DIGITAL_LIVE_NOT_VERIFIED",
  "DIGITAL_CONFIG_INVALID",
] as const;
export type DigitalErrorCode = (typeof DIGITAL_ERROR_CODES)[number];

export class DigitalError extends DomainError {
  constructor(code: DigitalErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
