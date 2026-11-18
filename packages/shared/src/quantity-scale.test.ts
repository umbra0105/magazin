import { describe, expect, it } from "vitest";
import { quantityFromTicks, scaleWholeByQuantity } from "./quantity";

describe("scaleWholeByQuantity", () => {
  it("înmulțește exact o mărime întreagă cu o cantitate zecimală", () => {
    // 2.500 g/rolă × 41,25 role = 103.125 g
    expect(scaleWholeByQuantity(2500, quantityFromTicks(412_500n))).toEqual({
      whole: 10_312_500n / 100n,
      remainderTicks: 0n,
    });
    // 3 g × 2,03 = 6,09 g: întregul 6 și restul 0,09 (900 zecimi de miime)
    expect(scaleWholeByQuantity(3, quantityFromTicks(20_300n))).toEqual({
      whole: 6n,
      remainderTicks: 900n,
    });
  });
  it("cantitate nulă sau valoare nulă dau 0", () => {
    expect(scaleWholeByQuantity(0, quantityFromTicks(10_000n))).toEqual({
      whole: 0n,
      remainderTicks: 0n,
    });
  });
  it("refuză valori negative sau care nu sunt întregi", () => {
    expect(() => scaleWholeByQuantity(-1, quantityFromTicks(10_000n))).toThrow();
    expect(() => scaleWholeByQuantity(1.5, quantityFromTicks(10_000n))).toThrow();
  });
  it("nu pierde precizie la valori mari (bigint)", () => {
    expect(scaleWholeByQuantity(2_000_000_000, quantityFromTicks(1_000_000_000_000n)).whole).toBe(
      2_000_000_000n * 100_000_000n,
    );
  });
});
