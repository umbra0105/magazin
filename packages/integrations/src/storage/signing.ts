import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Cheia pentru linkurile semnate ale driverului local, derivată din `APP_KEY` cu HKDF
 * (context separat de criptarea credențialelor: o cheie compromisă nu o compromite pe cealaltă).
 */
export function deriveSigningKey(appKeyBase64: string): Buffer {
  const secret = Buffer.from(appKeyBase64, "base64");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "ecom:storage:signed-url:v1", 32));
}

export interface SignedUrlClaims {
  key: string;
  /** Moment de expirare, secunde Unix. */
  expires: number;
  downloadFilename?: string;
}

function payload(claims: SignedUrlClaims): string {
  return JSON.stringify([claims.key, claims.expires, claims.downloadFilename ?? ""]);
}

export function signClaims(claims: SignedUrlClaims, signingKey: Buffer): string {
  return createHmac("sha256", signingKey).update(payload(claims)).digest("base64url");
}

/** Comparație în timp constant; respinge și semnăturile expirate. */
export function verifyClaims(
  claims: SignedUrlClaims,
  signature: string,
  signingKey: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isInteger(claims.expires) || claims.expires <= nowSeconds) return false;
  const expected = Buffer.from(signClaims(claims, signingKey));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
