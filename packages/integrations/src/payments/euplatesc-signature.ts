import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Semnătura EuPlătesc (protocol reimplementat din specificația bibliotecii MIT `euplatesc`, fără a o include ca dependență;
 * ⚠️ neconfirmat, de verificat cu sandbox real): un HMAC-MD5 cu cheia (hexazecimală) a comerciantului, calculat peste șirul
 * format, pentru fiecare câmp în ordine, din lungimea valorii urmată de valoare, sau un singur «-» când valoarea e goală;
 * rezultatul în hexazecimal MAJUSCULE. Câmpurile suplimentare ale răspunsului intră în hash în ordinea fixă de mai jos și DOAR
 * dacă au fost trimise (cele trimise se trec exact).
 */

export type SignedField = readonly [name: string, value: string | undefined | null];

export function signedString(fields: readonly SignedField[]): string {
  let out = "";
  for (const [, value] of fields) {
    const text = value === undefined || value === null ? "" : value;
    out += text.length === 0 ? "-" : `${text.length}${text}`;
  }
  return out;
}

const HEX_KEY = /^(?:[0-9a-fA-F]{2})+$/;

export function isHexKey(key: string): boolean {
  return HEX_KEY.test(key);
}

export function signFields(fields: readonly SignedField[], hexKey: string): string {
  if (!isHexKey(hexKey)) throw new RangeError("Cheia EuPlătesc nu e hexazecimală");
  return createHmac("md5", Buffer.from(hexKey, "hex"))
    .update(signedString(fields), "utf8")
    .digest("hex")
    .toUpperCase();
}

/** Comparație în timp constant, fără diferență între majuscule și minuscule. */
export function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given.toUpperCase(), "utf8");
  const b = Buffer.from(expected.toUpperCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Câmpurile suplimentare ale răspunsului: nume în hash, nume în cerere, în ordinea în care intră în hash. */
export const EUPLATESC_OPTIONAL_RESPONSE_FIELDS = [
  ["sec_status", "secStatus"],
  ["rrn", "rrn"],
  ["mcard", "mcard"],
  ["card_exp", "cardExp"],
  ["discount_amount", "discountAmount"],
  ["payment_channel", "paymentChannel"],
  ["card_type", "cardType"],
  ["bin", "bin"],
  ["rate", "rate"],
  ["card_holder", "cardHolder"],
  ["email", "email"],
  ["rtype", "rtype"],
  ["cce", "cce"],
] as const;

/** Momentul în format `YYYYMMDDHHmmss`, GMT. */
export function euplatescTimestamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  );
}
