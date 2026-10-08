import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { DomainError } from "@ecom/shared";

/** Versiunea formatului curent. Se schimbă (v2, ...) când se schimbă cheia sau algoritmul. */
export const CIPHER_VERSION = "v1";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Etichetă HKDF dedicată: aceeași APP_KEY nu produce aceeași cheie pentru alt scop. */
export const INTEGRATION_CREDENTIALS_KEY_LABEL = "ecom/integration-credentials/v1";

export class CryptoError extends DomainError {
  constructor(code: "CRYPTO_INVALID_KEY" | "CRYPTO_UNSUPPORTED_VERSION" | "CRYPTO_DECRYPT_FAILED") {
    super(code, MESSAGES[code]);
  }
}

const MESSAGES = {
  CRYPTO_INVALID_KEY: "APP_KEY invalidă: trebuie să fie 32 de octeți codați base64",
  CRYPTO_UNSUPPORTED_VERSION: "Format de criptare necunoscut",
  CRYPTO_DECRYPT_FAILED:
    "Decriptarea a eșuat: APP_KEY schimbată sau date alterate. Verifică APP_KEY din .env",
} as const;

/**
 * Derivă cheia de criptare din APP_KEY cu HKDF-SHA256. APP_KEY nu se folosește direct ca
 * cheie: eticheta (`info`) leagă cheia derivată de un singur scop.
 */
export function deriveKey(appKey: string, label: string): Buffer {
  const ikm = Buffer.from(appKey, "base64");
  if (ikm.length !== KEY_BYTES) throw new CryptoError("CRYPTO_INVALID_KEY");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), label, KEY_BYTES));
}

const b64 = (buffer: Buffer): string => buffer.toString("base64url");

/** Formatul: `v1:<iv>:<tag>:<ciphertext>`, părțile în base64url. IV nou la fiecare criptare. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [CIPHER_VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(":");
}

export function decrypt(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...extra] = value.split(":");
  if (version !== CIPHER_VERSION) throw new CryptoError("CRYPTO_UNSUPPORTED_VERSION");
  // Textul gol dă ciphertext gol (părți goale la sfârșit), deci îl verificăm doar ca "prezent".
  if (!iv || !tag || ciphertext === undefined || extra.length > 0)
    throw new CryptoError("CRYPTO_DECRYPT_FAILED");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Fără detalii din eroarea OpenSSL: nu vrem să scurgem nimic despre cheie sau date.
    throw new CryptoError("CRYPTO_DECRYPT_FAILED");
  }
}

/** Valoare mascată pentru afișare: `****abcd`. Sub 8 caractere nu se arată nimic. */
export function maskSecret(value: string): string {
  return value.length >= 8 ? `****${value.slice(-4)}` : "****";
}
