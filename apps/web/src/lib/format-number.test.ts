import { describe, expect, it } from "vitest";
import {
  formatEditableNumber,
  formatNumber,
  formatRange,
  parseEditableNumber,
} from "./format-number";

describe("numere în format românesc", () => {
  it("folosește virgula zecimală, nu punctul", () => {
    expect(formatNumber(2.5, "ro-RO")).toBe("2,5");
    expect(formatNumber(10.8, "ro-RO")).toBe("10,8");
    expect(formatNumber(85, "ro-RO")).toBe("85");
    expect(formatNumber(2.5, "ro-RO")).not.toContain(".");
  });

  it("nu rotunjește sub 4 zecimale", () => {
    expect(formatNumber(0.0625, "ro-RO")).toBe("0,0625");
  });

  it("textul editabil are virgulă și se citește înapoi, cu virgulă sau cu punct", () => {
    expect(formatEditableNumber(12.5)).toBe("12,5");
    expect(formatEditableNumber(1299)).toBe("1299");
    expect(parseEditableNumber("12,5")).toBe(12.5);
    expect(parseEditableNumber("12.5")).toBe(12.5);
    expect(parseEditableNumber("")).toBeNull();
    expect(parseEditableNumber("12,")).toBe(12);
    expect(parseEditableNumber("abc")).toBeNull();
  });

  it("intervalul din chip: ambele capete, doar minim sau doar maxim, cu unitate", () => {
    expect(formatRange({ min: 2.5, max: 12 }, "kW", "ro-RO")).toBe("2,5–12 kW");
    expect(formatRange({ min: 2.3, max: null }, "kW", "ro-RO")).toBe("≥ 2,3 kW");
    expect(formatRange({ min: null, max: 10.8 }, "kW", "ro-RO")).toBe("≤ 10,8 kW");
    expect(formatRange({ min: 15, max: null }, null, "ro-RO")).toBe("≥ 15");
  });
});
