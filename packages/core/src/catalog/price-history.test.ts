import { describe, expect, it } from "vitest";
import { lowestPriceInWindow, type PricePoint } from "./price-history";

const day = (n: number): Date => new Date(Date.UTC(2026, 8, 1) + n * 24 * 60 * 60 * 1000);
const point = (price: number, d: number): PricePoint => ({ price, effectiveFrom: day(d) });

// Reducerea se aplică în ziua 60; fereastra de referință e zilele 30..60 (60 exclusiv).
const UNTIL = day(60);

describe("lowestPriceInWindow (Omnibus, 30 de zile)", () => {
  it("fără istoric: null", () => {
    expect(lowestPriceInWindow([], { until: UNTIL })).toBeNull();
  });

  it("prețul în vigoare la începutul ferestrei intră, chiar dacă a fost setat mai demult", () => {
    expect(lowestPriceInWindow([point(19900, 0)], { until: UNTIL })).toBe(19900);
  });

  it("ia minimul dintre prețul de la început și schimbările din fereastră", () => {
    const history = [point(19900, 0), point(17900, 40), point(18900, 50)];
    expect(lowestPriceInWindow(history, { until: UNTIL })).toBe(17900);
  });

  it("un preț mai mic dinaintea ferestrei, înlocuit înainte de început, nu intră", () => {
    // 15000 a fost valabil doar între zilele 10 și 20: în afara ferestrei
    const history = [point(19900, 0), point(15000, 10), point(19900, 20)];
    expect(lowestPriceInWindow(history, { until: UNTIL })).toBe(19900);
  });

  it("prețul în vigoare la început e ultimul punct dinaintea lui, nu cel mai mic dintre cele vechi", () => {
    const history = [point(15000, 10), point(19900, 20)];
    expect(lowestPriceInWindow(history, { until: UNTIL })).toBe(19900);
  });

  it("limitele: punctul exact la început intră, cel exact la `until` (prețul redus) nu", () => {
    const atStart = [point(12000, 30), point(25000, 5)];
    expect(lowestPriceInWindow(atStart, { until: UNTIL })).toBe(12000);
    const atUntil = [point(19900, 0), point(9900, 60)];
    expect(lowestPriceInWindow(atUntil, { until: UNTIL })).toBe(19900);
  });

  it("produs nou: doar punctele din fereastră contează; nimic înainte de `until` → null", () => {
    expect(lowestPriceInWindow([point(19900, 45)], { until: UNTIL })).toBe(19900);
    expect(lowestPriceInWindow([point(19900, 70)], { until: UNTIL })).toBeNull();
  });

  it("nu depinde de ordinea punctelor", () => {
    const history = [point(18900, 50), point(19900, 0), point(17900, 40)];
    expect(lowestPriceInWindow(history, { until: UNTIL })).toBe(17900);
  });

  it("fereastra e configurabilă (zile), iar valorile invalide se resping", () => {
    const history = [point(19900, 0), point(17900, 40)];
    expect(lowestPriceInWindow(history, { until: UNTIL, days: 10 })).toBe(17900);
    expect(() => lowestPriceInWindow(history, { until: UNTIL, days: 0 })).toThrow(RangeError);
    expect(() => lowestPriceInWindow([point(199.5, 1)], { until: UNTIL })).toThrow(RangeError);
    expect(() => lowestPriceInWindow([point(-1, 1)], { until: UNTIL })).toThrow(RangeError);
  });
});
