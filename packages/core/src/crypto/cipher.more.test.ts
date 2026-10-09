import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  INTEGRATION_CREDENTIALS_KEY_LABEL,
  decrypt,
  deriveKey,
  encrypt,
} from "./cipher";

/**
 * VECTORI DE AUR. Ele leagă formatul și derivarea cheii de datele deja salvate în producție:
 * dacă un test de aici pică, o modificare ar face credențialele existente ilizibile. Nu "repara"
 * testul schimbând valorile; introdu un format nou (v2) și păstrează decriptarea v1.
 */
const GOLDEN_APP_KEY = Buffer.alloc(32, 7).toString("base64");
const GOLDEN_KEY_HEX = "ff2aeb78bf3d51b7c7063edfd7a27367230b4ef6b7fbdc7f38f8a1bbfb39f28e";
const GOLDEN_CIPHERTEXT =
  "v1:AwMDAwMDAwMDAwMD:1CRGniCxRxCuBWGqz2YdHQ:arqQRSmQ51MiPSbTqcRwpyx4G4YHIGw49tr9d7owbg";
const GOLDEN_PLAINTEXT = '{"apiKey":"sk_live_GOLDEN1234"}';

describe("criptare: vectori de aur (compatibilitate cu datele salvate)", () => {
  it("derivarea HKDF din APP_KEY cu eticheta integrărilor dă mereu aceeași cheie", () => {
    const key = deriveKey(GOLDEN_APP_KEY, INTEGRATION_CREDENTIALS_KEY_LABEL);
    expect(key.toString("hex")).toBe(GOLDEN_KEY_HEX);
    expect(INTEGRATION_CREDENTIALS_KEY_LABEL).toBe("ecom/integration-credentials/v1");
  });

  it("un text criptat v1 salvat acum se decriptează și în versiunile viitoare", () => {
    const key = deriveKey(GOLDEN_APP_KEY, INTEGRATION_CREDENTIALS_KEY_LABEL);
    expect(decrypt(GOLDEN_CIPHERTEXT, key)).toBe(GOLDEN_PLAINTEXT);
  });
});

describe("criptare: robustețe", () => {
  const key = deriveKey(randomBytes(32).toString("base64"), INTEGRATION_CREDENTIALS_KEY_LABEL);

  it("2000 de criptări ale aceluiași text dau 2000 de IV-uri și texte diferite", () => {
    const outputs = new Set<string>();
    const ivs = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const value = encrypt("acelasi-text", key);
      outputs.add(value);
      ivs.add(value.split(":")[1] ?? "");
    }
    expect(outputs.size).toBe(2000);
    expect(ivs.size).toBe(2000);
  });

  it("mesajul erorii nu conține textul în clar, textul criptat sau cheia", () => {
    const secret = "sk_live_FOARTE_SECRET";
    const value = encrypt(secret, key);
    const wrongKey = deriveKey(
      randomBytes(32).toString("base64"),
      INTEGRATION_CREDENTIALS_KEY_LABEL,
    );
    let message = "";
    try {
      decrypt(value, wrongKey);
    } catch (error) {
      message = `${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(value.split(":")[3] ?? "<lipsă>");
    expect(message).not.toContain(key.toString("hex"));
    expect(message).not.toContain(key.toString("base64"));
  });

  it.each([
    "",
    "v1",
    "v1:",
    "v1:::",
    "v1:a:b",
    "v1:a:b:c:d",
    "v1:%%%:@@@:###",
    "v1:AwMDAwMDAwMDAwMD:scurt:aaaa",
    "text oarecare, nu un șir criptat",
  ])("intrarea malformată %j dă mereu o eroare tipată CryptoError", (input) => {
    expect(() => decrypt(input, key)).toThrow(CryptoError);
  });

  it("versiunile necunoscute și cele viitoare au cod separat de eroarea de decriptare", () => {
    for (const version of ["v0", "v2", "V1", "x"]) {
      const forged = encrypt("x", key).replace(/^v1/, version);
      expect(() => decrypt(forged, key)).toThrowError(
        expect.objectContaining({ code: "CRYPTO_UNSUPPORTED_VERSION" }),
      );
    }
  });

  it("criptează și decriptează texte mari și caractere speciale", () => {
    const big = "ăîșțâ€😀\n\t".repeat(20_000);
    expect(decrypt(encrypt(big, key), key)).toBe(big);
  });

  it("deriveKey respinge APP_KEY goală, prea scurtă sau prea lungă", () => {
    for (const bad of [
      "",
      "abc",
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
    ]) {
      expect(() => deriveKey(bad, "eticheta"), bad).toThrowError(
        expect.objectContaining({ code: "CRYPTO_INVALID_KEY" }),
      );
    }
  });
});
