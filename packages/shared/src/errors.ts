/** Eroare de domeniu cu cod stabil (nu se schimbă între versiuni; clienții API se bazează pe el). */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Date de intrare invalide (formulare, API, setări). */
export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details);
  }
}
