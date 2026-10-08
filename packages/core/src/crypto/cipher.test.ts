import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CIPHER_VERSION,
  CryptoError,
  INTEGRATION_CREDENTIALS_KEY_LABEL,
  decrypt,
  deriveKey,
  encrypt,
  maskSecret,
} from "./cipher";

const appKey = randomBytes(32).toString("base64");
const key = deriveKey(appKey, INTEGRATION_CREDENTIALS_KEY_LABEL);

describe("deriveKey", () => {
  it("este determinist și nu e APP_KEY însăși", () => {
    expect(deriveKey(appKey, "a").equals(deriveKey(appKey, "a"))).toBe(true);
    expect(key.equals(Buffer.from(appKey, "base64"))).toBe(false);
    expect(key).toHaveLength(32);
  });

  it("etichete diferite dau chei diferite; APP_KEY diferite la fel", () => {
    expect(deriveKey(appKey, "a").equals(deriveKey(appKey, "b"))).toBe(false);
    const other = randomBytes(32).toString("base64");
    expect(deriveKey(appKey, "a").equals(deriveKey(other, "a"))).toBe(false);
  });

  it("respinge o APP_KEY de lungime greșită", () => {
    expect(() => deriveKey(randomBytes(16).toString("base64"), "a")).toThrow(CryptoError);
  });
});

describe("encrypt / decrypt", () => {
  it("face roundtrip, inclusiv cu diacritice și text gol", () => {
    for (const text of ["cheie-secretă-ăîșțâ", "", '{"apiKey":"abc123"}']) {
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    }
  });

  it("are prefix de versiune și nu conține textul în clar", () => {
    const value = encrypt("parola-foarte-secreta", key);
    expect(value.startsWith(`${CIPHER_VERSION}:`)).toBe(true);
    expect(value.split(":")).toHaveLength(4);
    expect(value).not.toContain("parola");
  });

  it("folosește IV nou la fiecare criptare", () => {
    expect(encrypt("la-fel", key)).not.toBe(encrypt("la-fel", key));
  });

  it("detectează alterarea ciphertext-ului sau a tag-ului", () => {
    const [v, iv, tag, ct] = encrypt("secret", key).split(":") as [string, string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(() => decrypt([v, iv, tag, flip(ct)].join(":"), key)).toThrow(CryptoError);
    expect(() => decrypt([v, iv, flip(tag), ct].join(":"), key)).toThrow(CryptoError);
  });

  it("nu se poate decripta cu altă cheie (APP_KEY schimbată)", () => {
    const value = encrypt("secret", key);
    const wrong = deriveKey(randomBytes(32).toString("base64"), INTEGRATION_CREDENTIALS_KEY_LABEL);
    expect(() => decrypt(value, wrong)).toThrowError(/APP_KEY/);
  });

  it("respinge versiune necunoscută și formate invalide, cu cod stabil", () => {
    const value = encrypt("secret", key);
    expect(() => decrypt(value.replace("v1:", "v9:"), key)).toThrowError(
      expect.objectContaining({ code: "CRYPTO_UNSUPPORTED_VERSION" }),
    );
    expect(() => decrypt("text-in-clar", key)).toThrow(CryptoError);
    expect(() => decrypt("v1:a:b", key)).toThrowError(
      expect.objectContaining({ code: "CRYPTO_DECRYPT_FAILED" }),
    );
  });
});

describe("maskSecret", () => {
  it("arată doar ultimele 4 caractere, iar valorile scurte deloc", () => {
    expect(maskSecret("sk_live_abcdef1234")).toBe("****1234");
    expect(maskSecret("abc123")).toBe("****");
  });
});
