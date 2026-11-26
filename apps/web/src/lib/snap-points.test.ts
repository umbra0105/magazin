import { describe, expect, it } from "vitest";
import { snapPoints } from "./snap-points";

describe("câmpul de puncte", () => {
  it("0 sau cel puțin minimul: urcând sub minim se sare la minim, coborând la 0", () => {
    expect(snapPoints(1, 0, 10, 50)).toBe(10);
    expect(snapPoints(9, 10, 10, 50)).toBe(0);
    expect(snapPoints(10, 0, 10, 50)).toBe(10);
    expect(snapPoints(27, 10, 10, 50)).toBe(27);
  });

  it("niciodată peste maxim, sub 0 sau cu zecimale", () => {
    expect(snapPoints(80, 10, 10, 50)).toBe(50);
    expect(snapPoints(-3, 10, 10, 50)).toBe(0);
    expect(snapPoints(Number.NaN, 10, 10, 50)).toBe(0);
    expect(snapPoints(20.9, 10, 10, 50)).toBe(20);
  });
});
