import { describe, expect, it } from "vitest";
import { decimalStringToMinor, minorToDecimalString } from "./payment-provider";

describe("minorToDecimalString", () => {
  it("scrie bani întregi ca text zecimal cu două zecimale", () => {
    expect(minorToDecimalString(0)).toBe("0.00");
    expect(minorToDecimalString(5)).toBe("0.05");
    expect(minorToDecimalString(100)).toBe("1.00");
    expect(minorToDecimalString(19_900)).toBe("199.00");
    expect(minorToDecimalString(1_000_001)).toBe("10000.01");
  });
  it("refuză sume negative sau fracționare", () => {
    expect(() => minorToDecimalString(-1)).toThrow(RangeError);
    expect(() => minorToDecimalString(1.5)).toThrow(RangeError);
    expect(() => minorToDecimalString(Number.NaN)).toThrow(RangeError);
  });
});

describe("decimalStringToMinor", () => {
  it("citește exact, fără float", () => {
    expect(decimalStringToMinor("123.45")).toBe(12_345);
    expect(decimalStringToMinor("123.4")).toBe(12_340);
    expect(decimalStringToMinor("123")).toBe(12_300);
    expect(decimalStringToMinor("0.07")).toBe(7);
    expect(decimalStringToMinor("19.99")).toBe(1_999);
    expect(decimalStringToMinor("0.29")).toBe(29);
  });
  it("respinge tot ce nu e un zecimal exact cu cel mult 2 zecimale", () => {
    for (const bad of [
      "",
      "1.234",
      "-1",
      "+1",
      "1e3",
      " 1",
      "1 ",
      "1,5",
      ".5",
      "1.",
      "abc",
      "NaN",
      "1234567890",
    ]) {
      expect(decimalStringToMinor(bad), bad).toBeNull();
    }
  });
  it("e inversul lui minorToDecimalString", () => {
    for (const minor of [0, 1, 99, 100, 101, 12_345, 99_999_999]) {
      expect(decimalStringToMinor(minorToDecimalString(minor))).toBe(minor);
    }
  });
});
