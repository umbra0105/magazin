import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Accesul la pagina de confirmare a comenzii (fără cont): după plasare, clientul primește un cookie semnat cu HMAC care leagă
 * ID-ul comenzii de un termen de expirare. Nu există un ID în adresă și nu se stochează nimic în bază; cheia derivă din `APP_KEY`.
 * Pentru a vedea comanda ulterior, clientul folosește urmărirea (număr + email).
 */

const SEPARATOR = ".";

function mac(orderId: string, expiresAtSeconds: number, key: Buffer): string {
  return createHmac("sha256", key)
    .update(`order-access:${orderId}:${expiresAtSeconds}`)
    .digest("base64url");
}

export function signOrderAccess(orderId: string, key: Buffer, expiresAtSeconds: number): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(orderId)) throw new RangeError("ID de comandă nevalid");
  if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new RangeError("Termenul de expirare nu este valid");
  }
  return [orderId, String(expiresAtSeconds), mac(orderId, expiresAtSeconds, key)].join(SEPARATOR);
}

/** ID-ul comenzii dacă jetonul e autentic și neexpirat; altfel `null` (nicio informație despre motiv). */
export function verifyOrderAccess(token: string, key: Buffer, nowSeconds: number): string | null {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [orderId, expires, signature] = parts as [string, string, string];
  const expiresAt = Number(expires);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(orderId) || !Number.isInteger(expiresAt) || expiresAt <= 0)
    return null;
  const expected = Buffer.from(mac(orderId, expiresAt, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return nowSeconds <= expiresAt ? orderId : null;
}
