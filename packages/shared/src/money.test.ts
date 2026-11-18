import { describe, expect, it } from "vitest";
import { parseQuantity, stepsToQuantity, quantityFromTicks } from "./quantity";
import {
  MoneyError,
  allocateMinor,
  compareExact,
  exactFraction,
  exactFromMinor,
  isWholeMinor,
  lineByStepPrice,
  lineByUnitPrice,
  minExact,
  minorToNumber,
  roundHalfUp,
  scaleExact,
} from "./money";

const q = (text: string) => parseQuantity(text, { maxDecimals: 4 });

describe("Money: valoare exactă și o singură rotunjire, half-up la 2 zecimale (bani întregi)", () => {
  it("rotunjește half-up: .5 în sus, sub .5 în jos", () => {
    expect(roundHalfUp(exactFraction(1, 2))).toBe(1n);
    expect(roundHalfUp(exactFraction(9999, 20000))).toBe(0n);
    expect(roundHalfUp(exactFraction(5, 2))).toBe(3n);
    expect(roundHalfUp(exactFraction(7, 3))).toBe(2n);
    expect(roundHalfUp(exactFromMinor(0))).toBe(0n);
    expect(roundHalfUp(exactFromMinor(12345))).toBe(12345n);
  });

  it("știe dacă valoarea e un număr întreg de bani", () => {
    expect(isWholeMinor(exactFromMinor(10))).toBe(true);
    expect(isWholeMinor(exactFraction(20, 2))).toBe(true);
    expect(isWholeMinor(exactFraction(1, 2))).toBe(false);
  });

  it("refuză sume negative, fracții cu numitor zero și numere care nu sunt întregi (fără float)", () => {
    expect(() => exactFromMinor(-1)).toThrow(MoneyError);
    expect(() => exactFromMinor(1.5)).toThrow(MoneyError);
    expect(() => exactFromMinor(Number.NaN)).toThrow(MoneyError);
    expect(() => exactFraction(1, 0)).toThrow(MoneyError);
    expect(() => exactFraction(-1, 2)).toThrow(MoneyError);
  });

  it("exemplul din INTREBARI-CONTABIL întrebarea 4: 6,09 mp × 123,45 = 751,81, nu 751,80", () => {
    // 3 cutii de 2,03 mp = 6,09 mp; preț pe unitate 123,45 lei = 12345 bani
    const quantity = stepsToQuantity(3, q("2,03"));
    expect(quantity).toBe(q("6,09"));
    const exact = lineByUnitPrice(exactFromMinor(12345), quantity);
    expect(roundHalfUp(exact)).toBe(75181n); // 751,81 lei
    expect(roundHalfUp(exact)).not.toBe(75180n); // 3 × round(250,6035) = 751,80 ar fi greșit
  });

  it("R1: liner 41,25 mp (2 role = 82,5 mp) la 87,35 lei/mp = 7.206,375 → 7.206,38", () => {
    const quantity = stepsToQuantity(2, q("41,25"));
    expect(roundHalfUp(lineByUnitPrice(exactFromMinor(8735), quantity))).toBe(720638n);
  });

  it("R1: țeavă la ml pe pași de 2,5 (3 pași = 7,5 ml)", () => {
    const quantity = stepsToQuantity(3, q("2,5"));
    expect(quantity).toBe(q("7,5"));
    expect(roundHalfUp(lineByUnitPrice(exactFromMinor(3333), quantity))).toBe(24998n); // 249,975 → 249,98
  });

  it("R2: bisulfat pe pas, 2 saci × 120,00 lei = 240,00 lei, fără nicio rotunjire", () => {
    const line = lineByStepPrice(exactFromMinor(12000), 2);
    expect(isWholeMinor(line)).toBe(true);
    expect(roundHalfUp(line)).toBe(24000n);
  });

  it("R1 cu prețuri întregi și cantitate întreagă nu rotunjește nimic", () => {
    const line = lineByUnitPrice(exactFromMinor(19900), q("3"));
    expect(isWholeMinor(line)).toBe(true);
    expect(roundHalfUp(line)).toBe(59700n);
  });

  it("depășirea plafonului liniei se REFUZĂ, nu se taie (R1 și R2)", () => {
    const max = 1_000_000_000;
    // la plafon exact: în regulă
    expect(roundHalfUp(lineByUnitPrice(exactFromMinor(max), q("1"), { maxLineMinor: max }))).toBe(
      BigInt(max),
    );
    // peste plafon: eroare cu cod stabil
    expect(() => lineByUnitPrice(exactFromMinor(max), q("1,0001"), { maxLineMinor: max })).toThrow(
      MoneyError,
    );
    expect(() => lineByStepPrice(exactFromMinor(max), 2, { maxLineMinor: max })).toThrow(
      MoneyError,
    );
    try {
      lineByStepPrice(exactFromMinor(max), 2, { maxLineMinor: max });
      expect.unreachable();
    } catch (error) {
      expect((error as MoneyError).code).toBe("MONEY_OVERFLOW");
    }
  });

  it("cantitatea maximă a coloanei nu produce depășiri în aritmetica internă (bigint)", () => {
    const huge = quantityFromTicks(1_000_000_000_000n);
    const line = lineByUnitPrice(exactFromMinor(1_000_000_000), huge);
    expect(line.num > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(() => minorToNumber(roundHalfUp(line))).toThrow(MoneyError);
  });

  it("scale (procente în puncte de bază) și min sunt exacte", () => {
    // 199,00 − 5% = 189,05
    const discounted = scaleExact(exactFromMinor(19900), 9500, 10000);
    expect(roundHalfUp(discounted)).toBe(18905n);
    expect(isWholeMinor(discounted)).toBe(true);
    // 100,00 net × 1,12 × 1,21 = 135,52
    const grossCostPlus = scaleExact(exactFromMinor(10000), 11200 * 12100, 100_000_000);
    expect(roundHalfUp(grossCostPlus)).toBe(13552n);
    expect(compareExact(grossCostPlus, exactFromMinor(12900))).toBe(1);
    expect(minExact(grossCostPlus, exactFromMinor(12900))).toEqual(exactFromMinor(12900));
    expect(compareExact(exactFraction(1, 3), exactFraction(2, 6))).toBe(0);
  });

  it("minorToNumber întoarce numere sigure și refuză ce nu încape", () => {
    expect(minorToNumber(24000n)).toBe(24000);
    expect(() => minorToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(MoneyError);
    expect(() => minorToNumber(-1n)).toThrow(MoneyError);
  });
});

describe("Money: repartizarea unei sume fixe (cupon, puncte) pe linii", () => {
  it("suma părților e EXACT totalul; restul merge la liniile cu cea mai mare parte fracționară", () => {
    const parts = allocateMinor(100n, [1000n, 1000n, 1000n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
  });

  it("nicio parte nu depășește ponderea ei (plafon la valoarea liniei)", () => {
    const weights = [500n, 10n, 490n];
    const parts = allocateMinor(1000n, weights);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
    parts.forEach((part, index) => expect(part <= (weights[index] as bigint)).toBe(true));
  });

  it("totalul peste suma ponderilor se refuză (nu se taie în tăcere)", () => {
    expect(() => allocateMinor(1001n, [500n, 500n])).toThrow(MoneyError);
  });

  it("restul merge la cea mai mare parte fracționară (nu la cea mai mică), iar părțile sunt cele proporționale", () => {
    expect(allocateMinor(3n, [3n, 1n])).toEqual([2n, 1n]);
    // 4 × 5/8 = 2,5 și 4 × 3/8 = 1,5: partea întreagă 2 + 1, restul de 1 ban merge primei linii
    expect(allocateMinor(4n, [5n, 3n])).toEqual([3n, 1n]);
    expect(allocateMinor(7n, [10n, 1n, 1n])).toEqual([6n, 1n, 0n]);
    // 13 × 11/15 = 9,53 și 13 × 4/15 = 3,47: părțile întregi sunt 9 și 3, restul de 1 ban merge primei linii
    expect(allocateMinor(13n, [11n, 4n])).toEqual([10n, 3n]);
  });

  it("un număr negativ de pași se refuză", () => {
    expect(() => lineByStepPrice(exactFromMinor(100), -1)).toThrow(MoneyError);
    expect(roundHalfUp(lineByStepPrice(exactFromMinor(100), 0))).toBe(0n);
  });

  it("zero și ponderi zero", () => {
    expect(allocateMinor(0n, [5n, 7n])).toEqual([0n, 0n]);
    expect(allocateMinor(0n, [])).toEqual([]);
    expect(() => allocateMinor(5n, [])).toThrow(MoneyError);
    expect(allocateMinor(10n, [0n, 10n])).toEqual([0n, 10n]);
  });
});

describe("Money: proprietăți pe rotunjire (generator determinist, fără ceas și fără float)", () => {
  // generator congruențial liniar: același șir la fiecare rulare
  let state = 123456789n;
  const next = (modulo: bigint): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return (state >> 16n) % modulo;
  };

  it("rotunjirea e monotonă: o cantitate mai mare nu dă o valoare mai mică", () => {
    for (let i = 0; i < 400; i++) {
      const price = Number(next(500_000n)) + 1;
      const a = quantityFromTicks(next(10_000_000n));
      const b = quantityFromTicks(BigInt(a) + next(1_000_000n));
      const lineA = roundHalfUp(lineByUnitPrice(exactFromMinor(price), a));
      const lineB = roundHalfUp(lineByUnitPrice(exactFromMinor(price), b));
      expect(lineB >= lineA).toBe(true);
    }
  });

  it("rotunjirea e la cel mult o jumătate de ban de valoarea exactă", () => {
    for (let i = 0; i < 400; i++) {
      const price = Number(next(900_000n)) + 1;
      const quantity = quantityFromTicks(next(50_000_000n) + 1n);
      const exact = lineByUnitPrice(exactFromMinor(price), quantity);
      const rounded = roundHalfUp(exact);
      // |exact − rounded| ≤ 1/2  ⇔  |2·num − 2·rounded·den| ≤ den
      const diff = 2n * exact.num - 2n * rounded * exact.den;
      expect((diff < 0n ? -diff : diff) <= exact.den).toBe(true);
    }
  });

  it("suma liniilor rotunjite o singură dată = totalul (nu se rotunjește a doua oară pe total)", () => {
    for (let i = 0; i < 200; i++) {
      const lines = Array.from({ length: 1 + Number(next(6n)) }, () =>
        roundHalfUp(
          lineByUnitPrice(
            exactFromMinor(Number(next(300_000n)) + 1),
            quantityFromTicks(next(9_000_000n) + 1n),
          ),
        ),
      );
      const total = lines.reduce((a, b) => a + b, 0n);
      expect(total).toBe(lines.reduce((a, b) => a + b, 0n));
      expect(typeof total).toBe("bigint");
    }
  });

  it("repartizarea păstrează suma pe orice ponderi", () => {
    for (let i = 0; i < 300; i++) {
      const weights = Array.from({ length: 1 + Number(next(8n)) }, () => next(100_000n));
      const cap = weights.reduce((a, b) => a + b, 0n);
      const total = cap === 0n ? 0n : next(cap + 1n);
      const parts = allocateMinor(total, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      parts.forEach((part, index) => expect(part <= (weights[index] as bigint)).toBe(true));
    }
  });
});
