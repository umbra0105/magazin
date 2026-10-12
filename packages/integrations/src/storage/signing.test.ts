import { describe, expect, it } from "vitest";
import { deriveSigningKey, signClaims, verifyClaims } from "./signing";

const appKey = Buffer.alloc(32, 7).toString("base64");
const key = deriveSigningKey(appKey);
const now = 1_800_000_000;
const claims = { key: "private/digital/a.pdf", expires: now + 60 };

describe("linkuri semnate (local)", () => {
  it("cheia derivată e de 32 de octeți și diferă de APP_KEY", () => {
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(appKey, "base64"))).toBe(false);
    expect(deriveSigningKey(appKey).equals(key)).toBe(true);
  });

  it("semnătura validă trece, până la expirare", () => {
    const sig = signClaims(claims, key);
    expect(verifyClaims(claims, sig, key, now)).toBe(true);
    expect(verifyClaims(claims, sig, key, now + 59)).toBe(true);
    expect(verifyClaims(claims, sig, key, now + 60)).toBe(false);
    expect(verifyClaims(claims, sig, key, now + 3600)).toBe(false);
  });

  it("orice modificare a cheii, expirării sau numelui de descărcare invalidează semnătura", () => {
    const sig = signClaims(claims, key);
    expect(verifyClaims({ ...claims, key: "private/digital/b.pdf" }, sig, key, now)).toBe(false);
    expect(verifyClaims({ ...claims, expires: claims.expires + 1000 }, sig, key, now)).toBe(false);
    expect(verifyClaims({ ...claims, downloadFilename: "x.pdf" }, sig, key, now)).toBe(false);
  });

  it("altă cheie sau o semnătură goală/trunchiată nu trece", () => {
    const sig = signClaims(claims, key);
    const other = deriveSigningKey(Buffer.alloc(32, 9).toString("base64"));
    expect(verifyClaims(claims, sig, other, now)).toBe(false);
    expect(verifyClaims(claims, "", key, now)).toBe(false);
    expect(verifyClaims(claims, sig.slice(0, -2), key, now)).toBe(false);
    expect(verifyClaims({ ...claims, expires: Number.NaN }, sig, key, now)).toBe(false);
  });

  it("câmpurile nu pot fi amestecate între ele (fără ambiguități)", () => {
    const a = signClaims({ key: "private/a/b", expires: now + 10, downloadFilename: "c" }, key);
    const b = signClaims({ key: "private/a/bc", expires: now + 10 }, key);
    expect(a).not.toBe(b);
  });
});
