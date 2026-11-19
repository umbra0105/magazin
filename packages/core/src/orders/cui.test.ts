import { describe, expect, it } from "vitest";
import { cuiCheckDigit, validateCui } from "./cui";

describe("CUI: format și cifra de control", () => {
  // CUI-uri publice de firme mari (verificabile în registrul ANAF)
  it.each([
    ["14399840", "14399840"],
    ["RO14399840", "14399840"],
    ["ro 14399840", "14399840"],
    [" RO14399840 ", "14399840"],
    ["2816464", "2816464"],
    ["9010105", "9010105"],
    ["8971726", "8971726"],
  ])("acceptă %s", (input, digits) => {
    const result = validateCui(input);
    expect(result).toEqual({ ok: true, digits, hasVatPrefix: /^\s*ro/i.test(input) });
  });

  it("calculează cifra de control cu cheia 753217532, aliniată la dreapta", () => {
    // 1439984 → 0 (eMAG), 281646 → 4 (Dedeman), 901010 → 5 (Orange), 897172 → 6 (Vodafone)
    expect(cuiCheckDigit("1439984")).toBe(0);
    expect(cuiCheckDigit("281646")).toBe(4);
    expect(cuiCheckDigit("901010")).toBe(5);
    expect(cuiCheckDigit("897172")).toBe(6);
  });

  it("restul 10 devine cifra 0", () => {
    // 11 · 0 + 10: caută un corp cu suma×10 mod 11 = 10
    const body = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
      .flatMap((a) => ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((b) => `${a}${b}`))
      .find(
        (b) =>
          cuiCheckDigit(b) === 0 &&
          ((): boolean => {
            const key = [7, 5, 3, 2, 1, 7, 5, 3, 2].slice(-b.length);
            const sum = [...b].reduce((acc, d, i) => acc + Number(d) * (key[i] as number), 0);
            return (sum * 10) % 11 === 10;
          })(),
      );
    expect(body).toBeDefined();
    expect(validateCui(`${body}0`).ok).toBe(true);
    expect(validateCui(`${body}1`).ok).toBe(false);
  });

  it("refuză o cifră de control greșită", () => {
    expect(validateCui("14399841")).toMatchObject({ ok: false, reason: "check_digit" });
    expect(validateCui("2816465")).toMatchObject({ ok: false, reason: "check_digit" });
  });

  it("refuză lungimi în afara 2–10 cifre", () => {
    expect(validateCui("1")).toMatchObject({ ok: false, reason: "format" });
    expect(validateCui("12345678901")).toMatchObject({ ok: false, reason: "format" });
    expect(validateCui("")).toMatchObject({ ok: false, reason: "format" });
  });

  it("refuză litere, separatori, zecimale și prefixe străine", () => {
    for (const bad of [
      "1439984a",
      "14399-840",
      "14399.840",
      "HU14399840",
      "R014399840",
      "14 399 840",
      "RO",
      "RO-14399840",
    ]) {
      expect(validateCui(bad), bad).toMatchObject({ ok: false, reason: "format" });
    }
  });

  it("fără prefix RO, o firmă neplătitoare de TVA are tot cifre valide", () => {
    expect(validateCui("2816464")).toMatchObject({ ok: true, hasVatPrefix: false });
  });
});
