import { describe, expect, it } from "vitest";
import {
  basisPointsToPercent,
  clampBasisPoints,
  percentToBasisPoints,
  pixelsToBasisPoints,
} from "./basis-points";

describe("procente ↔ puncte de bază", () => {
  it("convertește exact, cu virgulă sau punct, fără float", () => {
    expect(percentToBasisPoints("12,34")).toBe(1234);
    expect(percentToBasisPoints("12.5")).toBe(1250);
    expect(percentToBasisPoints("0")).toBe(0);
    expect(percentToBasisPoints("100")).toBe(10000);
    expect(percentToBasisPoints(" 7,05 % ")).toBe(705);
    expect(percentToBasisPoints("0,01")).toBe(1);
    // valori pe care float le-ar strica (0,29 × 100 = 28,999…)
    expect(percentToBasisPoints("0,29")).toBe(29);
    expect(percentToBasisPoints("57,35")).toBe(5735);
  });

  it("refuză ce iese din 0–100%, are mai mult de 2 zecimale sau nu e număr", () => {
    for (const bad of ["100,01", "101", "-1", "12,345", "abc", "", "1e2", "12,", ",5"]) {
      expect(percentToBasisPoints(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("afișarea e inversa conversiei", () => {
    expect(basisPointsToPercent(1234)).toBe("12,34");
    expect(basisPointsToPercent(1250)).toBe("12,5");
    expect(basisPointsToPercent(10000)).toBe("100");
    expect(basisPointsToPercent(0)).toBe("0");
    expect(basisPointsToPercent(5)).toBe("0,05");
    for (let bp = 0; bp <= 10000; bp += 37) {
      expect(percentToBasisPoints(basisPointsToPercent(bp))).toBe(bp);
    }
  });

  it("mutarea cu săgeți rămâne în 0–10000", () => {
    expect(clampBasisPoints(50, -100)).toBe(0);
    expect(clampBasisPoints(9950, 100)).toBe(10000);
    expect(clampBasisPoints(5000, 1000)).toBe(6000);
  });

  it("click pe imagine: pixeli → puncte de bază rotunjite, în interval", () => {
    expect(pixelsToBasisPoints(0, 800)).toBe(0);
    expect(pixelsToBasisPoints(400, 800)).toBe(5000);
    expect(pixelsToBasisPoints(800, 800)).toBe(10000);
    expect(pixelsToBasisPoints(-5, 800)).toBe(0);
    expect(pixelsToBasisPoints(900, 800)).toBe(10000);
    expect(pixelsToBasisPoints(10, 0)).toBe(0);
    expect(pixelsToBasisPoints(1, 3)).toBe(3333);
  });
});
