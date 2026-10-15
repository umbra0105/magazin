import { describe, expect, it } from "vitest";
import { formatDecimalDisplay, parseDecimalInput } from "./decimal";

describe("numere zecimale exacte pentru atribute", () => {
  it("virgulă sau punct, aceeași valoare; forma canonică are punct", () => {
    expect(parseDecimalInput("12,5")).toBe("12.5");
    expect(parseDecimalInput("12.5")).toBe("12.5");
    expect(parseDecimalInput("  7 ")).toBe("7");
    expect(parseDecimalInput("1 299,5")).toBe("1299.5");
  });

  it("normalizează zerourile și minus zero", () => {
    expect(parseDecimalInput("12,50")).toBe("12.5");
    expect(parseDecimalInput("007,0100")).toBe("7.01");
    expect(parseDecimalInput("0")).toBe("0");
    expect(parseDecimalInput("-0,0")).toBe("0");
    expect(parseDecimalInput("0,0001")).toBe("0.0001");
  });

  it("negativele sunt permise (ex. temperaturi)", () => {
    expect(parseDecimalInput("-15,5")).toBe("-15.5");
  });

  it("nu pierde precizia: sume pe care float nu le reprezintă exact", () => {
    expect(parseDecimalInput("0,1")).toBe("0.1");
    expect(parseDecimalInput("0,3")).toBe("0.3");
    expect(parseDecimalInput("99999999999999,9999")).toBe("99999999999999.9999");
  });

  it("refuză ce nu e număr sau nu încape în NUMERIC(18,4)", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "12,5,3",
      "12.345.6",
      "1,23456", // 5 zecimale
      "100000000000000", // 15 cifre întregi
      "--1",
      "1e5",
      "+5",
      ",5",
      "5,",
      "NaN",
      "Infinity",
    ]) {
      expect(parseDecimalInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("afișarea folosește virgula", () => {
    expect(formatDecimalDisplay("12.5")).toBe("12,5");
    expect(formatDecimalDisplay("7")).toBe("7");
  });
});
