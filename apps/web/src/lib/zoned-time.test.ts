import { describe, expect, it } from "vitest";
import { formatZonedLocal, parseZonedLocal } from "./zoned-time";

const TZ = "Europe/Bucharest";

describe("data și ora în fusul magazinului", () => {
  it("iarna: UTC+2; vara: UTC+3", () => {
    expect(parseZonedLocal("2026-01-15T10:30", TZ)?.toISOString()).toBe("2026-01-15T08:30:00.000Z");
    expect(parseZonedLocal("2026-07-15T10:30", TZ)?.toISOString()).toBe("2026-07-15T07:30:00.000Z");
  });

  it("formatarea e inversa parsării", () => {
    for (const local of ["2026-01-15T00:00", "2026-07-01T23:59", "2026-10-25T12:00"]) {
      const date = parseZonedLocal(local, TZ) as Date;
      expect(formatZonedLocal(date, TZ)).toBe(local);
    }
  });

  it("nu depinde de fusul browserului: același rezultat în UTC și în New York", () => {
    const a = parseZonedLocal("2026-11-01T00:00", TZ)?.toISOString();
    expect(a).toBe("2026-10-31T22:00:00.000Z");
  });

  it("ora care nu există (golul de primăvară, 29.03.2026 03:30) și formatele greșite dau null", () => {
    expect(parseZonedLocal("2026-03-29T03:30", TZ)).toBeNull();
    expect(parseZonedLocal("2026-13-01T00:00", TZ)).toBeNull();
    expect(parseZonedLocal("2026-02-30T10:00", TZ)).toBeNull();
    expect(parseZonedLocal("azi", TZ)).toBeNull();
    expect(parseZonedLocal("", TZ)).toBeNull();
  });
});
