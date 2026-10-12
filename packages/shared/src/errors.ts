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

/** Nu există utilizator autentificat (sesiune lipsă sau expirată). */
export class UnauthenticatedError extends DomainError {
  constructor(message = "Autentificarea este necesară") {
    super("AUTH_UNAUTHENTICATED", message);
  }
}

/** Utilizatorul e autentificat, dar nu are permisiunea cerută. */
export class ForbiddenError extends DomainError {
  constructor(permission: string) {
    super("AUTH_FORBIDDEN", "Nu ai permisiunea necesară pentru această acțiune", { permission });
  }
}

/** Un serviciu extern (storage, plăți, curier, facturare) a eșuat sau a fost configurat greșit. */
export class IntegrationError extends DomainError {}
