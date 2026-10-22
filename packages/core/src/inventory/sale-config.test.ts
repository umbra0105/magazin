import { describe, expect, it } from "vitest";
import { parseQuantity } from "@ecom/shared";
import {
  DEFAULT_SALE_STEP,
  checkSaleConfig,
  effectiveSaleStep,
  smartbillConversionExact,
} from "./sale-config";

const ticks = (text: string): bigint => parseQuantity(text);

describe("pasul efectiv: varianta, apoi produsul, apoi o unitate", () => {
  it("moștenirea", () => {
    expect(effectiveSaleStep(15_000, 25_000)).toBe(15_000n);
    expect(effectiveSaleStep(null, 25_000)).toBe(25_000n);
    expect(effectiveSaleStep(undefined, 25_000)).toBe(25_000n);
    expect(effectiveSaleStep(null, null)).toBe(DEFAULT_SALE_STEP);
    expect(effectiveSaleStep(null, undefined)).toBe(10_000n); // o unitate = 1,0000
  });
});

describe("pasul față de zecimalele unității", () => {
  const ok = (unitDecimals: number, step: string) =>
    checkSaleConfig({
      unitDecimals,
      step: ticks(step),
      smartbillMode: null,
      smartbillRatio: null,
    });

  it("pasul propriu al celor 6 produse e valid pe unitatea lor", () => {
    expect(ok(1, "2,5")).toEqual([]); // țeavă, ml cu o zecimală
    expect(ok(2, "41,25")).toEqual([]); // liner, mp cu două
    expect(ok(2, "2,03")).toEqual([]); // mozaic
    expect(ok(0, "25")).toEqual([]); // sac de 25 kg, kg fără zecimale
    expect(ok(4, "1")).toEqual([]);
    expect(ok(1, "1,8")).toEqual([]); // abachi
    expect(ok(0, "1")).toEqual([]); // buc
  });

  it("un pas cu mai multe zecimale decât unitatea e refuzat, cu mesaj pe câmpul pasului", () => {
    const issues = ok(0, "2,5");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("saleStep");
    expect(issues[0]?.message).toMatch(/zecimale/);
    expect(ok(1, "2,03")).toHaveLength(1);
    expect(ok(2, "0,001")).toHaveLength(1);
  });
});

describe("conversia SmartBill: orice comandă valabilă se convertește exact", () => {
  const check = (
    unitDecimals: number,
    step: string,
    smartbillMode: string | null,
    smartbillRatio: number | null,
  ) => checkSaleConfig({ unitDecimals, step: ticks(step), smartbillMode, smartbillRatio });

  it("fără conversie, aceeași unitate și «1 bucată SmartBill = 1 pas» sunt mereu exacte", () => {
    for (const mode of [null, "same_unit", "steps"]) {
      expect(check(2, "41,25", mode, null)).toEqual([]);
    }
  });

  it("raport: rola de 41,25 mp (1 rolă SmartBill = 41,25 mp) cu pasul de 41,25 e exactă", () => {
    expect(check(2, "41,25", "ratio", 412_500)).toEqual([]);
    // pasul de 2 role (82,5 mp) la același raport: 2 role SmartBill, tot exact
    expect(smartbillConversionExact(ticks("82,5"), 412_500)).toBe(true);
    // o jumătate de rolă (20,625 mp) cu raportul 41,25: 0,5 rolă, exact (4 zecimale)
    expect(smartbillConversionExact(ticks("20,625"), 412_500)).toBe(true);
  });

  it("raport care nu împarte pasul: refuzat, cu explicația pe câmpul raportului", () => {
    // 2,5 ml, 1 bucată SmartBill = 3 ml: 2,5 / 3 = 0,8333… bucăți: nu e exact
    const issues = check(1, "2,5", "ratio", 30_000);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("smartbillRatio");
    expect(issues[0]?.message).toMatch(/exact/);
    expect(issues[0]?.message).toContain("2,5");
  });

  it("raportul zero sau lipsă la modul «raport» e refuzat", () => {
    for (const ratio of [null, 0, -1]) {
      expect(check(2, "1", "ratio", ratio).map((i) => i.path)).toEqual(["smartbillRatio"]);
    }
  });

  it("raport fără mod «raport» e refuzat (una setată, una nulă)", () => {
    for (const mode of [null, "same_unit", "steps"]) {
      expect(check(2, "1", mode, 10_000).map((i) => i.path)).toEqual(["smartbillRatio"]);
    }
  });

  it("pe 400 de perechi aleatorii, «exact pentru pasul» ⇔ «exact pentru primii 25 de multipli»", () => {
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 400; i++) {
      const step = BigInt(1 + Math.floor(rnd() * 500_000));
      const ratio = 1 + Math.floor(rnd() * 600_000);
      const exactForAll = Array.from({ length: 25 }, (_, n) => BigInt(n + 1) * step).every(
        (value) => (value * 10_000n) % BigInt(ratio) === 0n,
      );
      expect(smartbillConversionExact(step, ratio), `${step}/${ratio}`).toBe(exactForAll);
    }
  });
});
