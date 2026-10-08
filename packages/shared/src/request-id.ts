/** Headerul prin care requestId circulă între middleware, handlere și răspuns. */
export const REQUEST_ID_HEADER = "x-request-id";

// Acceptăm doar id-uri sigure: un client nu poate injecta rânduri noi sau șiruri uriașe în loguri.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Folosește id-ul primit dacă e valid, altfel generează unul nou. Compatibil Edge (fără API Node). */
export function resolveRequestId(incoming: string | null | undefined): string {
  return incoming && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}
