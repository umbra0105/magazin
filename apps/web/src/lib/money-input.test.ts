import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "./money-input";

describe("parseMoneyInput", () => {
  it("lei → bani, cu virgulă sau punct, fără float", () => {
    expect(parseMoneyInput("199")).toBe(19900);
    expect(parseMoneyInput("199,5")).toBe(19950);
    expect(parseMoneyInput("199.50")).toBe(19950);
    expect(parseMoneyInput(" 1 299,00 ")).toBe(129900);
    expect(parseMoneyInput("0,07")).toBe(7);
    expect(parseMoneyInput("19,99")).toBe(1999);
  });

  it("refuză: gol, negativ, mai mult de 2 zecimale, text, sume uriașe", () => {
    for (const bad of ["", " ", "-5", "1,999", "abc", "1,2,3", "12e3", "99999999999999999999"]) {
      expect(parseMoneyInput(bad), bad).toBeNull();
    }
  });
});

describe("formatare", () => {
  it("formatMoneyInput e inversul lui parseMoneyInput", () => {
    for (const bani of [0, 7, 1999, 19950, 129900]) {
      expect(parseMoneyInput(formatMoneyInput(bani))).toBe(bani);
    }
    expect(formatMoneyInput(19950)).toBe("199,50");
  });

  it("formatMoney folosește moneda și limba din setări", () => {
    expect(formatMoney(19950, "RON", "ro-RO")).toMatch(/199,50/);
    expect(formatMoney(19950, "RON", "ro-RO")).toMatch(/RON/);
  });
});
