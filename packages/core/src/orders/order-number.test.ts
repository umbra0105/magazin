import { describe, expect, it } from "vitest";
import { formatOrderNumber } from "./order-number";

describe("numărul de comandă = prefix + contor cu zerouri la stânga", () => {
  it("fără prefix: doar cifre, completate la lățimea setată", () => {
    expect(formatOrderNumber("", 1, 6)).toBe("000001");
    expect(formatOrderNumber("", 123456, 6)).toBe("123456");
  });
  it("cu prefix din setări", () => {
    expect(formatOrderNumber("WEB-", 42, 6)).toBe("WEB-000042");
    expect(formatOrderNumber("T", 7, 3)).toBe("T007");
  });
  it("peste lățime nu se taie: numărul crește (1.000.000 cu 6 cifre)", () => {
    expect(formatOrderNumber("", 1_000_000, 6)).toBe("1000000");
  });
  it("refuză o valoare de contor care nu e întreg pozitiv", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatOrderNumber("", bad, 6), String(bad)).toThrow(RangeError);
    }
  });
  it("refuză o lățime în afara 1–12", () => {
    expect(() => formatOrderNumber("", 1, 0)).toThrow(RangeError);
    expect(() => formatOrderNumber("", 1, 13)).toThrow(RangeError);
  });
  it("refuză un prefix cu caractere în afara literelor, cifrelor și cratimei", () => {
    expect(() => formatOrderNumber("WEB #", 1, 6)).toThrow(RangeError);
    expect(() => formatOrderNumber("A".repeat(11), 1, 6)).toThrow(RangeError);
  });
});
