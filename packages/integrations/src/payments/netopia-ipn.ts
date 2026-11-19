import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { WebhookRejectedError, type WebhookRejectReason } from "@ecom/shared";

/**
 * Verificarea IPN-ului Netopia v2 (⚠️ NECONFIRMAT, DE VERIFICAT CU SANDBOX REAL: schema vine din codul unui proiect care o
 * citează din SDK-urile oficiale; documentația v2 citită nu descrie semnătura IPN). FAIL-CLOSED:
 *
 *  - antetul `Verification-token` e un JWT; se acceptă DOAR algoritmul `RS512` (orice altul — `none`, `HS256/384/512`,
 *    `RS256`… — e respins înainte de orice altă verificare: atacul de confuzie de algoritm, în care cheia publică ar fi
 *    folosită ca secret HMAC, nu are cale);
 *  - semnătura se verifică cu cheia publică RSA Netopia, cu `node:crypto`;
 *  - `iss` = «NETOPIA Payments»; `aud` conține una dintre semnăturile POS configurate; `sub` = base64(SHA-512(corpul BRUT)),
 *    comparat în timp constant. Corpul se hash-uiește exact așa cum a venit (octeți), nu re-serializat;
 *  - `exp`/`nbf`, dacă apar, se respectă (toleranță 60 s).
 */

const EXPECTED_ISSUER = "NETOPIA Payments";
const CLOCK_TOLERANCE_SECONDS = 60;

const b64urlToBuffer = (text: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  return Buffer.from(text, "base64url");
};

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

const reject = (reason: WebhookRejectReason): never => {
  throw new WebhookRejectedError(reason);
};

/** Cheia publică poate fi lipită cu sau fără antetul PEM (cheie publică sau certificat). */
export function parsePublicKey(text: string): KeyObject | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const pem = trimmed.includes("BEGIN")
    ? trimmed
    : `-----BEGIN PUBLIC KEY-----\n${(trimmed.replace(/\s+/g, "").match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----`;
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "rsa" ? key : null;
  } catch {
    return null;
  }
}

export interface IpnVerificationConfig {
  publicKey: string;
  /** Semnăturile POS acceptate ca `aud` (unul sau mai multe). */
  posSignatures: readonly string[];
  nowSeconds: number;
}

/** Aruncă `WebhookRejectedError` dacă tokenul nu poate fi crezut; altfel nu întoarce nimic (corpul poate fi folosit). */
export function verifyNetopiaIpn(
  rawBody: Buffer,
  token: string | undefined,
  config: IpnVerificationConfig,
): void {
  const key = parsePublicKey(config.publicKey);
  const signatures = config.posSignatures.map((s) => s.trim()).filter((s) => s !== "");
  if (!key || signatures.length === 0) return reject("not_configured");
  if (token === undefined || token.trim() === "") return reject("signature_missing");

  const parts = token.trim().split(".");
  if (parts.length !== 3) return reject("signature_malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const headerBytes = b64urlToBuffer(headerPart);
  const payloadBytes = b64urlToBuffer(payloadPart);
  const signature = b64urlToBuffer(signaturePart);
  if (!headerBytes || !payloadBytes || !signature || signature.length === 0) {
    return reject("signature_malformed");
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return reject("signature_malformed");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return reject("signature_malformed");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return reject("signature_malformed");
  }
  // 1. algoritmul, înaintea oricărei verificări criptografice
  if ((header as Record<string, unknown>)["alg"] !== "RS512")
    return reject("algorithm_not_allowed");

  // 2. semnătura
  const valid = verify(
    "RSA-SHA512",
    Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
    key,
    signature,
  );
  if (!valid) return reject("signature_invalid");

  // 3. revendicările (credibile doar după ce semnătura e validă)
  const claims = payload as Record<string, unknown>;
  if (claims["iss"] !== EXPECTED_ISSUER) return reject("issuer_invalid");
  const audiences = Array.isArray(claims["aud"]) ? claims["aud"] : [claims["aud"]];
  const audOk = audiences.some(
    (aud) => typeof aud === "string" && signatures.some((expected) => safeEqual(aud, expected)),
  );
  if (!audOk) return reject("audience_invalid");
  const exp = claims["exp"];
  if (typeof exp === "number" && config.nowSeconds > exp + CLOCK_TOLERANCE_SECONDS) {
    return reject("signature_invalid");
  }
  const nbf = claims["nbf"];
  if (typeof nbf === "number" && config.nowSeconds < nbf - CLOCK_TOLERANCE_SECONDS) {
    return reject("signature_invalid");
  }
  const expectedSub = createHash("sha512").update(rawBody).digest("base64");
  const sub = claims["sub"];
  if (typeof sub !== "string" || !safeEqual(sub, expectedSub)) return reject("body_hash_mismatch");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
