import { describe, expect, it } from "vitest";
import { formatScaledInput, parseScaledInput } from "./scaled-input";

describe("kg ↔ grame (3 zecimale)", () => {
  it("600 kg = 600.000 g; 12,5 kg = 12.500 g; 0,001 kg = 1 g", () => {
    expect(parseScaledInput("600", 3)).toBe(600_000);
    expect(parseScaledInput("12,5", 3)).toBe(12_500);
    expect(parseScaledInput("12.5", 3)).toBe(12_500);
    expect(parseScaledInput("0,001", 3)).toBe(1);
  });
  it("refuză prea multe zecimale, text, negativ, gol", () => {
    for (const bad of ["1,2345", "abc", "-5", "", " ", "1,", ",5", "1e3"]) {
      expect(parseScaledInput(bad, 3), bad).toBeNull();
    }
  });
  it("acceptă spații în număr (1 200)", () => {
    expect(parseScaledInput(" 1 200 ", 3)).toBe(1_200_000);
  });
});

describe("m³ ↔ cm³ (6 zecimale)", () => {
  it("1,2 m³ = 1.200.000 cm³; 0,000001 m³ = 1 cm³", () => {
    expect(parseScaledInput("1,2", 6)).toBe(1_200_000);
    expect(parseScaledInput("0,000001", 6)).toBe(1);
  });
  it("refuză valori peste limita sigură", () => {
    expect(parseScaledInput("99999999999999", 6)).toBeNull();
  });
});

describe("afișare", () => {
  it("fără zerouri de prisos", () => {
    expect(formatScaledInput(600_000, 3)).toBe("600");
    expect(formatScaledInput(12_500, 3)).toBe("12,5");
    expect(formatScaledInput(1_200_000, 6)).toBe("1,2");
    expect(formatScaledInput(1, 6)).toBe("0,000001");
    expect(formatScaledInput(0, 3)).toBe("0");
  });
  it("tur-retur", () => {
    for (const v of [1, 999, 1000, 600_000, 1_200_000, 123_456_789]) {
      expect(parseScaledInput(formatScaledInput(v, 3), 3)).toBe(v);
      expect(parseScaledInput(formatScaledInput(v, 6), 6)).toBe(v);
    }
  });
});
