import { DomainError } from "@ecom/shared";

export type MediaErrorCode =
  | "MEDIA_EMPTY"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_UNSUPPORTED_TYPE"
  | "MEDIA_IMAGE_TOO_BIG"
  | "MEDIA_CORRUPT"
  | "MEDIA_FOLDER_NOT_FOUND"
  | "MEDIA_BUSY";

/** Statusul HTTP potrivit fiecărui cod (folosit de ruta de upload). */
export const MEDIA_ERROR_STATUS: Record<MediaErrorCode, number> = {
  MEDIA_EMPTY: 400,
  MEDIA_TOO_LARGE: 413,
  MEDIA_UNSUPPORTED_TYPE: 415,
  MEDIA_IMAGE_TOO_BIG: 422,
  MEDIA_CORRUPT: 422,
  MEDIA_FOLDER_NOT_FOUND: 422,
  MEDIA_BUSY: 503,
};

/** Un fișier a fost refuzat la încărcare. Mesajele nu conțin numele sau conținutul fișierului. */
export class MediaError extends DomainError {
  declare readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
