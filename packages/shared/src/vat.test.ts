import { describe, expect, it } from "vitest";
import { netFromGross, percentToBasisPoints, vatFromGross } from "./vat";

describe("TVA extras din brut", () => {
  it("cota în puncte de bază", () => {
    expect(percentToBasisPoints(21)).toBe(2100);
    expect(percentToBasisPoints(5.5)).toBe(550);
    expect(percentToBasisPoints(0)).toBe(0);
  });

  it("21%: 12100 brut = 10000 net + 2100 TVA", () => {
    expect(netFromGross(12100, 2100)).toBe(10000);
    expect(vatFromGross(12100, 2100)).toBe(2100);
  });

  it("rotunjește la bani o singură dată; net + TVA = brut mereu", () => {
    for (const gross of [1, 2, 99, 100, 19900, 12345, 99999, 1_000_000_000]) {
      const net = netFromGross(gross, 2100);
      expect(Number.isInteger(net)).toBe(true);
      expect(net + vatFromGross(gross, 2100)).toBe(gross);
    }
    // 199,00 lei cu TVA 21% → 164,46 fără TVA (164,4628…)
    expect(netFromGross(19900, 2100)).toBe(16446);
  });

  it("cotă 0: brutul e netul", () => {
    expect(netFromGross(5000, 0)).toBe(5000);
    expect(vatFromGross(5000, 0)).toBe(0);
  });

  it("refuză valori care nu sunt bani întregi sau cote negative", () => {
    expect(() => netFromGross(10.5, 2100)).toThrow(RangeError);
    expect(() => netFromGross(-1, 2100)).toThrow(RangeError);
    expect(() => netFromGross(100, -1)).toThrow(RangeError);
    expect(() => percentToBasisPoints(-1)).toThrow(RangeError);
    expect(() => percentToBasisPoints(Number.NaN)).toThrow(RangeError);
  });
});
