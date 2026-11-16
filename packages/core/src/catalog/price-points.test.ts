import { describe, expect, it } from "vitest";
import { planPricePoints, type PriceWindowVariant } from "./price-points";

const NOW = new Date("2030-06-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const plain = (price: number): PriceWindowVariant => ({
  price,
  salePrice: null,
  saleStartsAt: null,
  saleEndsAt: null,
});
const sale = (
  price: number,
  salePrice: number,
  start: Date | null,
  end: Date | null,
): PriceWindowVariant => ({ price, salePrice, saleStartsAt: start, saleEndsAt: end });

describe("planPricePoints: fără istoric", () => {
  it("prima observație: un singur punct, la momentul rulării (nu se inventează istoric înapoi)", () => {
    expect(planPricePoints(plain(10000), null, NOW)).toEqual([
      { price: 10000, effectiveFrom: NOW },
    ]);
    expect(planPricePoints(sale(10000, 7000, at(-3), at(3)), null, NOW)).toEqual([
      { price: 7000, effectiveFrom: NOW },
    ]);
  });
});

describe("planPricePoints: cu ultimul punct cunoscut", () => {
  it("prețul efectiv n-a schimbat nimic: niciun punct (idempotent)", () => {
    expect(planPricePoints(plain(10000), { price: 10000, effectiveFrom: at(-5) }, NOW)).toEqual([]);
    expect(
      planPricePoints(
        sale(10000, 7000, at(-3), at(3)),
        { price: 7000, effectiveFrom: at(-3) },
        NOW,
      ),
    ).toEqual([]);
  });

  it("promoție programată care a început între rulări: punctul se scrie la momentul ÎNCEPERII, nu al rulării", () => {
    const last = { price: 10000, effectiveFrom: at(-10) };
    expect(planPricePoints(sale(10000, 7000, at(-0.5), at(5)), last, NOW)).toEqual([
      { price: 7000, effectiveFrom: at(-0.5) },
    ]);
  });

  it("promoție care s-a încheiat între rulări: revenirea la prețul întreg la momentul încheierii", () => {
    const last = { price: 7000, effectiveFrom: at(-10) };
    expect(planPricePoints(sale(10000, 7000, at(-10), at(-1)), last, NOW)).toEqual([
      { price: 10000, effectiveFrom: at(-1) },
    ]);
  });

  it("început și sfârșit între aceleași două rulări: ambele tranziții, în ordine", () => {
    const last = { price: 10000, effectiveFrom: at(-10) };
    expect(planPricePoints(sale(10000, 7000, at(-3), at(-1)), last, NOW)).toEqual([
      { price: 7000, effectiveFrom: at(-3) },
      { price: 10000, effectiveFrom: at(-1) },
    ]);
  });

  it("tranziția fix la momentul rulării intră (capătul superior e inclusiv); cea fix la ultimul punct nu se repetă", () => {
    const last = { price: 10000, effectiveFrom: at(-10) };
    expect(planPricePoints(sale(10000, 7000, NOW, at(5)), last, NOW)).toEqual([
      { price: 7000, effectiveFrom: NOW },
    ]);
    const already = { price: 7000, effectiveFrom: at(-2) };
    expect(planPricePoints(sale(10000, 7000, at(-2), at(5)), already, NOW)).toEqual([]);
  });

  it("sfârșitul promoției e exclusiv: la momentul sfârșitului prețul e deja cel întreg", () => {
    const last = { price: 7000, effectiveFrom: at(-10) };
    expect(planPricePoints(sale(10000, 7000, at(-10), NOW), last, NOW)).toEqual([
      { price: 10000, effectiveFrom: NOW },
    ]);
  });

  it("prețul întreg schimbat de administrator între rulări (fără punct scris): se scrie la rulare", () => {
    expect(planPricePoints(plain(12000), { price: 10000, effectiveFrom: at(-5) }, NOW)).toEqual([
      { price: 12000, effectiveFrom: NOW },
    ]);
  });

  it("promoție fără date (activă imediat) e luată ca activă; prețul redus nu depășește prețul întreg", () => {
    expect(
      planPricePoints(sale(10000, 7000, null, null), { price: 10000, effectiveFrom: at(-1) }, NOW),
    ).toEqual([{ price: 7000, effectiveFrom: NOW }]);
    expect(
      planPricePoints(sale(10000, 12000, null, null), { price: 10000, effectiveFrom: at(-1) }, NOW),
    ).toEqual([]);
  });

  it("o schimbare la exact aceeași oră cu ultimul punct nu scrie un al doilea punct cu aceeași oră (cheie unică)", () => {
    expect(planPricePoints(plain(12000), { price: 10000, effectiveFrom: NOW }, NOW)).toEqual([]);
  });

  it("tranziții viitoare nu se scriu", () => {
    const last = { price: 10000, effectiveFrom: at(-1) };
    expect(planPricePoints(sale(10000, 7000, at(2), at(9)), last, NOW)).toEqual([]);
  });

  it("un punct mai nou decât ora rulării (ceas dat înapoi) nu produce nimic și nu aruncă", () => {
    expect(planPricePoints(plain(10000), { price: 10000, effectiveFrom: at(1) }, NOW)).toEqual([]);
  });
});
