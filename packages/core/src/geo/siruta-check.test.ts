import { describe, expect, it } from "vitest";
import { hasValidSirutaCheckDigit, sirutaCheckDigit } from "./siruta-check";

describe("cifra de control SIRUTA (Metodologie INS)", () => {
  it("reproduce exemplul din metodologie: 179132 are numărul unic 17913 și cifra 2", () => {
    expect(sirutaCheckDigit(17913)).toBe(2);
    expect(hasValidSirutaCheckDigit(179132)).toBe(true);
  });

  it("completează codul cu zerouri la stânga (județul Alba: 10 = 00001 + cifra 0)", () => {
    expect(hasValidSirutaCheckDigit(10)).toBe(true);
    expect(hasValidSirutaCheckDigit(1017)).toBe(true);
    expect(hasValidSirutaCheckDigit(1026)).toBe(true);
  });

  it("produsele se adună cifră cu cifră (35 contează 3+5), nu ca număr întreg", () => {
    // 5 × 7 = 35 -> 8 (nu 35); restul sumei 8 -> 11 - 8 = 3
    expect(sirutaCheckDigit(50000)).toBe(3);
    // varianta greșită (35 întreg): 35 % 10 = 5 -> 11 - 5 = 6
    expect(sirutaCheckDigit(50000)).not.toBe(6);
  });

  it("restul 0 al sumei dă cifra 1 (11 - 0 = 11, restul la 10)", () => {
    // suma 0 (număr unic 0) are rest 0 -> cifra 1
    expect(sirutaCheckDigit(0)).toBe(1);
    // 10 × ... : un număr cu suma 10: 00055 -> 5*2... verificat prin definiție
    // cifrele 0,0,0,5,5 × 7,5,3,2,1 = 0,0,0,10,5 -> 1+0+5 = 6 -> 11-6 = 5
    expect(sirutaCheckDigit(55)).toBe(5);
  });

  it("refuză un cod care nu e întreg între 1 și 999999", () => {
    expect(hasValidSirutaCheckDigit(0)).toBe(false);
    expect(hasValidSirutaCheckDigit(-5)).toBe(false);
    expect(hasValidSirutaCheckDigit(1_000_000)).toBe(false);
    expect(hasValidSirutaCheckDigit(10.5)).toBe(false);
    expect(hasValidSirutaCheckDigit(Number.NaN)).toBe(false);
  });

  it("o cifră greșită nu trece", () => {
    expect(hasValidSirutaCheckDigit(179133)).toBe(false);
    expect(hasValidSirutaCheckDigit(1018)).toBe(false);
  });
});
