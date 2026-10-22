import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  MAX_QUANTITY,
  MAX_SALE_STEP,
  QUANTITY_FACTOR,
  QuantityError,
  addQuantity,
  applyDelta,
  assertOrderQuantity,
  assertSaleStep,
  compareQuantity,
  deltaBetween,
  divideByFactor,
  exactLineValue,
  exactStepsValue,
  floorSteps,
  formatQuantity,
  formatQuantityWithUnit,
  formatSignedDelta,
  isAmbiguousSeparatorText,
  isMultipleOf,
  maxQuantity,
  minQuantity,
  minimumOrderQuantity,
  multiplyByFactor,
  parseQuantity,
  parseQuantityDetailed,
  parseSignedDelta,
  quantityFromTicks,
  saleStepToInt,
  remainderAfterSteps,
  splitScaledMoney,
  stepsIn,
  stepsToQuantity,
  subtractQuantity,
  sumQuantities,
  type Quantity,
  type QuantityDelta,
} from "./quantity";

// ---------------------------------------------------------------------------
// Calcul de referință INDEPENDENT de modul: fracții exacte cu numitor propriu (nu zecimi de miime),
// adunare pe cifre zecimale (fără bigint) și `toFixed` pe valori mici. Nimic de aici nu folosește
// funcțiile din `quantity.ts`.
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b);
}

class Fraction {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint) {
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(text: string): Fraction {
    const [whole = "0", frac = ""] = text.replace(",", ".").split(".");
    return new Fraction(BigInt(whole + frac), 10n ** BigInt(frac.length));
  }
  times(other: Fraction): Fraction {
    return new Fraction(this.n * other.n, this.d * other.d);
  }
  plus(other: Fraction): Fraction {
    return new Fraction(this.n * other.d + other.n * this.d, this.d * other.d);
  }
  minus(other: Fraction): Fraction {
    return new Fraction(this.n * other.d - other.n * this.d, this.d * other.d);
  }
  equals(other: Fraction): boolean {
    return this.n * other.d === other.n * this.d;
  }
  /** Partea întreagă a câtului (pentru valori ≥ 0) */
  floorDiv(other: Fraction): bigint {
    return (this.n * other.d) / (this.d * other.n);
  }
  /** Zecimalele cu `digits` cifre, trunchiate (împărțire lungă, nu `toFixed`) */
  truncated(digits: number): string {
    const scaled = (this.n * 10n ** BigInt(digits)) / this.d;
    const s = scaled.toString().padStart(digits + 1, "0");
    return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }
}

/** Adunare a două șiruri zecimale pe cifre, cu report (fără bigint și fără Number) */
function addDecimalStrings(a: string, b: string): string {
  const [aw = "0", af = ""] = a.split(".");
  const [bw = "0", bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const x = (aw + af.padEnd(scale, "0")).split("").reverse();
  const y = (bw + bf.padEnd(scale, "0")).split("").reverse();
  const out: number[] = [];
  let carry = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const sum = Number(x[i] ?? 0) + Number(y[i] ?? 0) + carry;
    out.push(sum % 10);
    carry = Math.floor(sum / 10);
  }
  if (carry) out.push(carry);
  const digits = out
    .reverse()
    .join("")
    .padStart(scale + 1, "0");
  const joined = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return joined.includes(".") ? joined.replace(/\.?0+$/, "") : joined;
}

function repeatedSum(step: string, times: number): string {
  let total = "0";
  for (let i = 0; i < times; i++) total = addDecimalStrings(total, step);
  return total;
}

/** Forma canonică cu punct a unui număr formatat de modul („82,5” → „82.5”) */
const canonical = (formatted: string): string => formatted.replace(",", ".");

/** PRNG determinist (mulberry32) pentru testele pe valori aleatorii */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (text: string): Quantity => parseQuantity(text);
const fmt = (value: Quantity): string => formatQuantity(value);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof QuantityError) return e.code;
    throw e;
  }
  return "OK";
}

// ---------------------------------------------------------------------------

describe("citire: virgulă sau punct, exact, fără float", () => {
  it.each([
    ["0", 0n],
    ["0,0001", 1n],
    ["2,03", 20_300n],
    ["2.03", 20_300n],
    ["  2,03  ", 20_300n],
    ["41,25", 412_500n],
    ["25", 250_000n],
    ["007", 70_000n],
    ["0,3", 3_000n],
    ["1,50000", 15_000n], // zerouri de la coadă dincolo de 4 zecimale nu schimbă valoarea
    ["100000000", MAX_QUANTITY],
  ])("%s → %s zecimi de miime", (input, ticks) => {
    expect(parseQuantity(input)).toBe(ticks);
  });

  it.each([
    ["", "QUANTITY_INVALID_FORMAT"],
    ["   ", "QUANTITY_INVALID_FORMAT"],
    ["abc", "QUANTITY_INVALID_FORMAT"],
    ["1,2,3", "QUANTITY_INVALID_FORMAT"],
    ["1.234,5", "QUANTITY_INVALID_FORMAT"], // separator de mii: nu ghicim
    ["1 234", "QUANTITY_INVALID_FORMAT"],
    [",5", "QUANTITY_INVALID_FORMAT"],
    ["5,", "QUANTITY_INVALID_FORMAT"],
    ["1e3", "QUANTITY_INVALID_FORMAT"],
    ["١٢٣", "QUANTITY_INVALID_FORMAT"], // cifre non-ASCII
    ["+5", "QUANTITY_INVALID_FORMAT"],
    ["5".repeat(60), "QUANTITY_INVALID_FORMAT"],
    ["2,03456", "QUANTITY_TOO_MANY_DECIMALS"],
    ["-1", "QUANTITY_NEGATIVE"],
    ["-0,0001", "QUANTITY_NEGATIVE"],
    ["100000000,0001", "QUANTITY_OVERFLOW"],
    ["999999999999", "QUANTITY_OVERFLOW"],
  ])("refuză %j cu %s", (input, expected) => {
    expect(code(() => parseQuantity(input))).toBe(expected);
  });

  it("«-0» este zero, nu negativ", () => {
    expect(parseQuantity("-0")).toBe(0n);
    expect(parseQuantity("-0,0000")).toBe(0n);
  });

  it("precizia unității: zecimalele peste cele ale unității se refuză", () => {
    expect(parseQuantity("2,5", { maxDecimals: 1 })).toBe(25_000n);
    expect(code(() => parseQuantity("2,53", { maxDecimals: 1 }))).toBe(
      "QUANTITY_TOO_MANY_DECIMALS",
    );
    expect(code(() => parseQuantity("2,5", { maxDecimals: 0 }))).toBe("QUANTITY_TOO_MANY_DECIMALS");
    expect(parseQuantity("2,0", { maxDecimals: 0 })).toBe(20_000n);
    expect(code(() => parseQuantity("1", { maxDecimals: 5 }))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => parseQuantity("1", { maxDecimals: -1 }))).toBe("QUANTITY_INVALID_ARGUMENT");
  });

  it("citirea cu rotunjire în jos (SmartBill, conversii) spune dacă a pierdut ceva", () => {
    expect(parseQuantityDetailed("1,23456")).toEqual({ quantity: 12_345n, truncated: true });
    expect(parseQuantityDetailed("1,23450")).toEqual({ quantity: 12_345n, truncated: false });
    expect(parseQuantityDetailed("1,239", { maxDecimals: 2 })).toEqual({
      quantity: 12_300n,
      truncated: true,
    });
    expect(parseQuantityDetailed("2,999999")).toEqual({ quantity: 29_999n, truncated: true });
    // niciodată în sus: 0,99999 → 0,9999
    expect(parseQuantityDetailed("0,99999").quantity).toBe(9_999n);
    // și în modul «în jos» negativul și depășirea se refuză
    expect(code(() => parseQuantityDetailed("-1,5"))).toBe("QUANTITY_NEGATIVE");
    expect(code(() => parseQuantityDetailed("100000000,5"))).toBe("QUANTITY_OVERFLOW");
  });

  it("textul ambiguu «1.234» / «1,234» (poate fi mii) e semnalat pentru importuri", () => {
    for (const text of ["1.234", "1,234", "12.345", "999,999"]) {
      expect(isAmbiguousSeparatorText(text), text).toBe(true);
    }
    for (const text of ["1.23", "1,2345", "1234", "0,123", "1.234.567", "12,5", "1.2"]) {
      expect(isAmbiguousSeparatorText(text), text).toBe(false);
    }
  });
});

describe("formatare cu virgulă", () => {
  it.each([
    [0n, "0"],
    [1n, "0,0001"],
    [20_300n, "2,03"],
    [412_500n, "41,25"],
    [250_000n, "25"],
    [825_000n, "82,5"],
    [MAX_QUANTITY, "100000000"],
  ])("%s → %s", (ticks, text) => {
    expect(formatQuantity(quantityFromTicks(ticks))).toBe(text);
  });

  it("zecimale minime și maxime, cu unitate", () => {
    const value = q("82,5");
    expect(formatQuantity(value, { minDecimals: 2 })).toBe("82,50");
    expect(formatQuantity(q("2,0345"), { maxDecimals: 2 })).toBe("2,03"); // doar afișare, în jos
    expect(formatQuantityWithUnit(value, "mp")).toBe("82,5 mp");
    expect(formatQuantityWithUnit(q("25"), "kg")).toBe("25 kg");
  });

  it("dus-întors pentru 2000 de valori aleatorii (citire ∘ formatare = identitate)", () => {
    const rnd = prng(7);
    for (let i = 0; i < 2000; i++) {
      const ticks = BigInt(Math.floor(rnd() * 1e12));
      const value = quantityFromTicks(ticks);
      expect(parseQuantity(formatQuantity(value, { minDecimals: 4 }))).toBe(value);
      expect(parseQuantity(formatQuantity(value))).toBe(value);
    }
  });
});

describe("din/în zecimi de miime (granița cu baza de date)", () => {
  it("acceptă bigint și numere întregi sigure, refuză restul", () => {
    expect(quantityFromTicks(5n)).toBe(5n);
    expect(quantityFromTicks(5)).toBe(5n);
    expect(quantityFromTicks(MAX_QUANTITY)).toBe(MAX_QUANTITY);
    expect(code(() => quantityFromTicks(-1n))).toBe("QUANTITY_NEGATIVE");
    expect(code(() => quantityFromTicks(MAX_QUANTITY + 1n))).toBe("QUANTITY_OVERFLOW");
    expect(code(() => quantityFromTicks(1.5))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => quantityFromTicks(Number.NaN))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => quantityFromTicks(Number.MAX_SAFE_INTEGER + 2))).toBe(
      "QUANTITY_INVALID_ARGUMENT",
    );
  });
});

describe("exactitate: ce float nu poate (cazurile din plan)", () => {
  it("0,1 + 0,2 = 0,3 exact (în float nu)", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addQuantity(q("0,1"), q("0,2"))).toBe(q("0,3"));
  });

  it("3 × 2,03 = 6,09 exact (mozaic, 3 cutii)", () => {
    expect(stepsToQuantity(3, q("2,03"))).toBe(q("6,09"));
    expect(fmt(stepsToQuantity(3, q("2,03")))).toBe("6,09");
  });

  it("alte cazuri din cele 6 produse", () => {
    expect(fmt(stepsToQuantity(2, q("41,25")))).toBe("82,5"); // liner, 2 role
    expect(fmt(stepsToQuantity(7, q("2,5")))).toBe("17,5"); // țeavă, 7 pași
    expect(fmt(stepsToQuantity(3, q("25")))).toBe("75"); // bisulfat, 3 saci
    expect(fmt(stepsToQuantity(10, q("1,8")))).toBe("18"); // abachi 1,8 ml
    expect(fmt(stepsToQuantity(4, q("2,03")))).toBe("8,12");
  });

  it("10 × 0,3 = 3 exact; pe stoc 1,0 încap 3 pași și rămâne 0,1", () => {
    expect(0.3 * 3).not.toBe(0.9);
    expect(fmt(stepsToQuantity(10, q("0,3")))).toBe("3");
    expect(floorSteps(q("1"), q("0,3"))).toBe(3n);
    expect(fmt(remainderAfterSteps(q("1"), q("0,3")))).toBe("0,1");
    // 10 cereri de câte 0,3 pe stoc 1,0: exact 3 încap
    let left = q("1");
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      if (left >= q("0,3")) {
        left = subtractQuantity(left, q("0,3"));
        ok++;
      }
    }
    expect(ok).toBe(3);
    expect(fmt(left)).toBe("0,1");
  });

  it("liner: 100 mp, rola de 41,25 → 2 pași, rest 17,5 mp", () => {
    expect(floorSteps(q("100"), q("41,25"))).toBe(2n);
    expect(fmt(remainderAfterSteps(q("100"), q("41,25")))).toBe("17,5");
    expect(floorSteps(q("41,24"), q("41,25"))).toBe(0n);
    expect(fmt(remainderAfterSteps(q("41,24"), q("41,25")))).toBe("41,24");
  });
});

describe("pas de vânzare: multipli EXACȚI", () => {
  const step = q("2,03");

  it("multiplii sunt acceptați, orice altceva refuzat (și la o fracțiune de distanță)", () => {
    for (const n of [1n, 2n, 3n, 4n, 100n]) {
      const value = stepsToQuantity(n, step);
      expect(isMultipleOf(value, step), String(n)).toBe(true);
      expect(stepsIn(value, step)).toBe(n);
      // cea mai mică fracțiune (0,0001) mai sus sau mai jos
      expect(isMultipleOf(quantityFromTicks(value + 1n), step)).toBe(false);
      expect(isMultipleOf(quantityFromTicks(value - 1n), step)).toBe(false);
    }
    expect(isMultipleOf(q("0"), step)).toBe(true); // zero e multiplu; cererea de comandă îl refuză separat
    expect(code(() => stepsIn(q("6,1"), step))).toBe("QUANTITY_NOT_MULTIPLE_OF_STEP");
    expect(code(() => stepsIn(q("2,02"), step))).toBe("QUANTITY_NOT_MULTIPLE_OF_STEP");
  });

  it("mesajul de refuz spune pasul, în română, cu virgulă", () => {
    try {
      stepsIn(q("6,1"), step);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuantityError);
      expect((e as QuantityError).message).toBe("Cantitatea trebuie să fie multiplu de 2,03.");
      expect((e as QuantityError).details).toMatchObject({ reason: "not_multiple_of_step" });
    }
  });

  it("pasul: > 0, întreg, în limita coloanei INT, compatibil cu zecimalele unității", () => {
    expect(assertSaleStep(25_000)).toBe(25_000n);
    expect(assertSaleStep(25_000n)).toBe(25_000n);
    expect(assertSaleStep(MAX_SALE_STEP)).toBe(MAX_SALE_STEP);
    for (const bad of [0, -1, 1.5, Number.NaN, Number(MAX_SALE_STEP) + 1]) {
      expect(
        code(() => assertSaleStep(bad)),
        String(bad),
      ).toBe("QUANTITY_INVALID_STEP");
    }
    // 2,5 ml cere cel puțin 1 zecimală; o unitate fără zecimale nu admite 2,5
    expect(assertSaleStep(25_000, 1)).toBe(25_000n);
    expect(code(() => assertSaleStep(25_000, 0))).toBe("QUANTITY_INVALID_STEP");
    expect(assertSaleStep(10_000, 0)).toBe(10_000n);
    expect(assertSaleStep(412_500, 2)).toBe(412_500n);
    expect(code(() => assertSaleStep(412_500, 1))).toBe("QUANTITY_INVALID_STEP");
    expect(code(() => assertSaleStep(1, 3))).toBe("QUANTITY_INVALID_STEP");
    expect(assertSaleStep(1, 4)).toBe(1n);
  });

  it("pasul către coloana INT: exact, doar în limita ei", () => {
    expect(saleStepToInt(q("2,03"))).toBe(20_300);
    expect(saleStepToInt(q("41,25"))).toBe(412_500);
    expect(saleStepToInt(quantityFromTicks(MAX_SALE_STEP))).toBe(2_147_483_647);
    expect(code(() => saleStepToInt(quantityFromTicks(MAX_SALE_STEP + 1n)))).toBe(
      "QUANTITY_INVALID_STEP",
    );
    expect(code(() => saleStepToInt(0n as Quantity))).toBe("QUANTITY_INVALID_STEP");
  });

  it("minimul: implicit un pas; configurabil în pași", () => {
    expect(minimumOrderQuantity(step)).toBe(step);
    expect(minimumOrderQuantity(step, null)).toBe(step);
    expect(minimumOrderQuantity(step, 2)).toBe(q("4,06"));
    expect(code(() => minimumOrderQuantity(step, 0))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => minimumOrderQuantity(step, 1.5))).toBe("QUANTITY_INVALID_ARGUMENT");
  });

  it("cantitatea comandată: pozitivă, multiplu de pas, ≥ minim; întoarce numărul de pași", () => {
    expect(assertOrderQuantity(q("6,09"), { step })).toBe(3n);
    expect(assertOrderQuantity(q("4,06"), { step, minSteps: 2 })).toBe(2n);
    expect(code(() => assertOrderQuantity(q("0"), { step }))).toBe("QUANTITY_NOT_POSITIVE");
    expect(code(() => assertOrderQuantity(q("2,03"), { step, minSteps: 2 }))).toBe(
      "QUANTITY_BELOW_MINIMUM",
    );
    expect(code(() => assertOrderQuantity(q("6,1"), { step }))).toBe(
      "QUANTITY_NOT_MULTIPLE_OF_STEP",
    );
    expect(assertOrderQuantity(q("7"), { step: q("1") })).toBe(7n); // buc, pas implicit
  });

  it("pași aleatori (1–4 zecimale): n × pas acceptat, n × pas ± 1 refuzat, față de referință", () => {
    const rnd = prng(42);
    for (let i = 0; i < 800; i++) {
      const decimals = 1 + Math.floor(rnd() * 4);
      const stepText = (1 + Math.floor(rnd() * 9999)) / 10 ** decimals;
      const stepStr = stepText.toFixed(decimals);
      const step = parseQuantity(stepStr);
      if (step <= 1n) continue; // ±1 zecimă ar fi tot multiplu al lui 0,0001
      const n = 1 + Math.floor(rnd() * 40);
      const value = stepsToQuantity(n, step);
      // referință: adunări repetate pe cifre
      expect(canonical(formatQuantity(value)), `${stepStr} × ${n}`).toBe(
        repeatedSum(stepStr, n).replace(/\.$/, ""),
      );
      // referință: fracții exacte
      expect(
        Fraction.of(formatQuantity(value)).equals(
          Fraction.of(stepStr).times(Fraction.of(String(n))),
        ),
      ).toBe(true);
      expect(isMultipleOf(value, step)).toBe(true);
      expect(stepsIn(value, step)).toBe(BigInt(n));
      expect(isMultipleOf(quantityFromTicks(value + 1n), step)).toBe(false);
      expect(isMultipleOf(quantityFromTicks(value - 1n), step)).toBe(false);
    }
  });

  it("câtul și restul: n·pas + rest = disponibil, comparate cu fracții exacte", () => {
    const rnd = prng(99);
    for (let i = 0; i < 800; i++) {
      const available = quantityFromTicks(BigInt(Math.floor(rnd() * 1e9)));
      const step = quantityFromTicks(BigInt(1 + Math.floor(rnd() * 5e6)));
      const n = floorSteps(available, step);
      const rest = remainderAfterSteps(available, step);
      expect(stepsToQuantity(n, step) + rest).toBe(available);
      expect(rest < step).toBe(true);
      const ref = Fraction.of(formatQuantity(available, { minDecimals: 4 })).floorDiv(
        Fraction.of(formatQuantity(step, { minDecimals: 4 })),
      );
      expect(n).toBe(ref);
    }
  });
});

describe("aritmetică pe cantități: fără negativ, fără depășire", () => {
  it("adunare, scădere, comparare, minim/maxim, sumă", () => {
    expect(addQuantity(q("1,5"), q("2,25"))).toBe(q("3,75"));
    expect(subtractQuantity(q("3,75"), q("2,25"))).toBe(q("1,5"));
    expect(subtractQuantity(q("2"), q("2"))).toBe(0n);
    expect(compareQuantity(q("1"), q("2"))).toBe(-1);
    expect(compareQuantity(q("2"), q("2"))).toBe(0);
    expect(compareQuantity(q("3"), q("2"))).toBe(1);
    expect(minQuantity(q("1"), q("2"))).toBe(q("1"));
    expect(maxQuantity(q("1"), q("2"))).toBe(q("2"));
    expect(sumQuantities([q("0,1"), q("0,2"), q("0,3")])).toBe(q("0,6"));
    expect(sumQuantities([])).toBe(0n);
  });

  it("stocul nu poate deveni negativ (D5) și nu depășește plafonul", () => {
    expect(code(() => subtractQuantity(q("1"), q("1,0001")))).toBe("QUANTITY_NEGATIVE");
    expect(code(() => subtractQuantity(q("0"), q("0,0001")))).toBe("QUANTITY_NEGATIVE");
    expect(code(() => addQuantity(MAX_QUANTITY, quantityFromTicks(1n)))).toBe("QUANTITY_OVERFLOW");
    expect(addQuantity(quantityFromTicks(MAX_QUANTITY - 1n), quantityFromTicks(1n))).toBe(
      MAX_QUANTITY,
    );
    expect(code(() => sumQuantities([MAX_QUANTITY, quantityFromTicks(1n)]))).toBe(
      "QUANTITY_OVERFLOW",
    );
    expect(code(() => stepsToQuantity(MAX_QUANTITY, q("2")))).toBe("QUANTITY_OVERFLOW");
    expect(code(() => stepsToQuantity(-1, q("2")))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => stepsToQuantity(1.5, q("2")))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(stepsToQuantity(0, q("2"))).toBe(0n);
  });

  it("variațiile cu semn acceptă «+» (formatSignedDelta îl produce), iar cantitățile obișnuite nu", () => {
    expect(parseSignedDelta("+2,5")).toBe(25_000n);
    expect(parseSignedDelta(" +3 ")).toBe(30_000n);
    expect(parseSignedDelta("+0")).toBe(0n);
    for (const bad of ["+", "++5", "+-5", "-+5", "+ 5", "+,5", "+1,2,3"]) {
      expect(
        code(() => parseSignedDelta(bad)),
        bad,
      ).toBe("QUANTITY_INVALID_FORMAT");
    }
    expect(code(() => parseSignedDelta("+2,00001"))).toBe("QUANTITY_TOO_MANY_DECIMALS");
    expect(code(() => parseSignedDelta("+100000001"))).toBe("QUANTITY_OVERFLOW");
    // parserul și formatorul se închid unul pe altul, pentru orice variație
    for (const ticks of [
      -1_000_000_000_000n,
      -25_000n,
      -1n,
      0n,
      1n,
      412_500n,
      1_000_000_000_000n,
    ]) {
      const delta = ticks as QuantityDelta;
      expect(parseSignedDelta(formatSignedDelta(delta)), String(ticks)).toBe(delta);
    }
    // cantitatea obișnuită rămâne strictă
    expect(code(() => parseQuantity("+5"))).toBe("QUANTITY_INVALID_FORMAT");
  });

  it("variațiile (ajustări): pozitive, negative, zero, și aplicarea lor", () => {
    expect(parseSignedDelta("-2,5")).toBe(-25_000n);
    expect(parseSignedDelta("2,5")).toBe(25_000n);
    expect(parseSignedDelta("0")).toBe(0n);
    expect(formatSignedDelta(parseSignedDelta("-2,5"))).toBe("-2,5");
    expect(formatSignedDelta(parseSignedDelta("2,5"))).toBe("+2,5");
    expect(formatSignedDelta(parseSignedDelta("0"))).toBe("0");
    expect(code(() => parseSignedDelta("-100000001"))).toBe("QUANTITY_OVERFLOW");
    expect(code(() => parseSignedDelta("2,00001"))).toBe("QUANTITY_TOO_MANY_DECIMALS");
    expect(deltaBetween(q("10"), q("7,5"))).toBe(-25_000n);
    expect(applyDelta(q("10"), parseSignedDelta("-2,5"))).toBe(q("7,5"));
    expect(applyDelta(q("10"), parseSignedDelta("2,5"))).toBe(q("12,5"));
    expect(code(() => applyDelta(q("1"), parseSignedDelta("-1,0001")))).toBe("QUANTITY_NEGATIVE");
    expect(code(() => applyDelta(MAX_QUANTITY, parseSignedDelta("0,0001")))).toBe(
      "QUANTITY_OVERFLOW",
    );
  });
});

describe("factori de conversie (SmartBill ↔ unitatea noastră): în jos, cu semnal de pierdere", () => {
  it("1 rolă SmartBill = 41,25 mp: înmulțire exactă", () => {
    expect(multiplyByFactor(q("2"), q("41,25"))).toEqual({ quantity: q("82,5"), lossy: false });
    expect(multiplyByFactor(q("0,5"), q("41,25"))).toEqual({
      quantity: q("20,625"),
      lossy: false,
    });
  });

  it("înmulțire cu pierdere: se rotunjește ÎN JOS la 4 zecimale, niciodată în sus", () => {
    // 2,3333 role × 41,25 = 96,248625 → 96,2486 (în jos), pierdere
    expect(multiplyByFactor(q("2,3333"), q("41,25"))).toEqual({
      quantity: q("96,2486"),
      lossy: true,
    });
    // 0,0001 × 0,5 = 0,00005 → 0 (în jos)
    expect(multiplyByFactor(q("0,0001"), q("0,5"))).toEqual({ quantity: 0n, lossy: true });
  });

  it("împărțire (mp → role): 82,5 / 41,25 = 2; 100 / 41,25 = 2,4242 (în jos), cu pierdere", () => {
    expect(divideByFactor(q("82,5"), q("41,25"))).toEqual({ quantity: q("2"), lossy: false });
    expect(divideByFactor(q("100"), q("41,25"))).toEqual({ quantity: q("2,4242"), lossy: true });
    expect(code(() => divideByFactor(q("1"), 0n as Quantity))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => multiplyByFactor(q("1"), 0n as Quantity))).toBe("QUANTITY_INVALID_ARGUMENT");
  });

  it("depășirea plafonului după conversie se refuză, nu se taie", () => {
    expect(code(() => multiplyByFactor(q("90000000"), q("2")))).toBe("QUANTITY_OVERFLOW");
    expect(code(() => divideByFactor(q("90000000"), q("0,5")))).toBe("QUANTITY_OVERFLOW");
  });

  it("față de referință (fracții exacte): rezultat = partea întreagă a produsului exact", () => {
    const rnd = prng(2026);
    for (let i = 0; i < 800; i++) {
      const a = quantityFromTicks(BigInt(Math.floor(rnd() * 1e7)));
      const f = quantityFromTicks(BigInt(1 + Math.floor(rnd() * 2e6)));
      const A = Fraction.of(formatQuantity(a, { minDecimals: 4 }));
      const F = Fraction.of(formatQuantity(f, { minDecimals: 4 }));
      const mul = multiplyByFactor(a, f);
      expect(canonical(formatQuantity(mul.quantity, { minDecimals: 4 }))).toBe(
        A.times(F).truncated(4),
      );
      expect(mul.lossy).toBe((A.times(F).n * 10_000n) % A.times(F).d !== 0n);
      const div = divideByFactor(a, f);
      expect(canonical(formatQuantity(div.quantity, { minDecimals: 4 }))).toBe(
        new Fraction(A.n * F.d, A.d * F.n).truncated(4),
      );
    }
  });
});

describe("preț × cantitate: exact, fără regula de rotunjire", () => {
  it("valoare exactă în bani × 10⁻⁴ (R1: preț pe unitate)", () => {
    // 87,35 lei/mp × 82,5 mp = 7.206,375 lei = 720.637,5 bani → 7.206.375.000 în bani × 10⁻⁴... (8735 × 825000)
    expect(exactLineValue(8_735, q("82,5"))).toBe(8_735n * 825_000n);
    expect(exactLineValue(8_735, q("82,5"))).toBe(7_206_375_000n);
    // 123,45 lei/mp × 6,09 mp = 751,8105 lei
    expect(exactLineValue(12_345, q("6,09"))).toBe(751_810_500n);
    // 1 buc
    expect(exactLineValue(19_900, q("1"))).toBe(199_000_000n);
    expect(exactLineValue(0, q("5"))).toBe(0n);
    expect(exactLineValue(100n, q("0"))).toBe(0n);
  });

  it("descompunere exactă în bani întregi și rest (modulul NU alege rotunjirea)", () => {
    expect(splitScaledMoney(exactLineValue(12_345, q("6,09")))).toEqual({
      wholeMinor: 75_181n,
      remainderScaled: 500n, // 0,05 bani rămași, necunoscând regula de rotunjire
    });
    expect(splitScaledMoney(0n)).toEqual({ wholeMinor: 0n, remainderScaled: 0n });
    expect(splitScaledMoney(10_000n)).toEqual({ wholeMinor: 1n, remainderScaled: 0n });
    expect(splitScaledMoney(9_999n)).toEqual({ wholeMinor: 0n, remainderScaled: 9_999n });
    expect(code(() => splitScaledMoney(-1n))).toBe("QUANTITY_INVALID_ARGUMENT");
  });

  it("R2: preț pe pas × număr de pași, fără nicio fracțiune", () => {
    expect(exactStepsValue(12_000, 2)).toBe(24_000n); // 2 saci × 120,00 lei
    expect(exactStepsValue(12_000n, 3n)).toBe(36_000n);
    expect(exactStepsValue(12_000, 0)).toBe(0n);
    expect(code(() => exactStepsValue(12_000, -1))).toBe("QUANTITY_INVALID_ARGUMENT");
    expect(code(() => exactStepsValue(12_000, 1.5))).toBe("QUANTITY_INVALID_ARGUMENT");
  });

  it("intrări invalide și plafonul unei linii (MAX_MONEY al motorului)", () => {
    for (const price of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(
        code(() => exactLineValue(price, q("1"))),
        String(price),
      ).toBe("QUANTITY_INVALID_PRICE");
    }
    expect(code(() => exactLineValue(-1n, q("1")))).toBe("QUANTITY_INVALID_PRICE");
    const maxLineMinor = 1_000_000_000; // MAX_MONEY din catalog
    expect(exactLineValue(10_000_000, q("100"), { maxLineMinor })).toBe(10_000_000n * 1_000_000n);
    expect(code(() => exactLineValue(10_000_000, q("100,0001"), { maxLineMinor }))).toBe(
      "QUANTITY_OVERFLOW",
    );
    expect(code(() => exactStepsValue(500_000_000, 3, { maxLineMinor }))).toBe("QUANTITY_OVERFLOW");
    expect(exactStepsValue(500_000_000, 2, { maxLineMinor })).toBe(1_000_000_000n);
    // fără plafon, valoarea mare rămâne exactă (bigint), peste limita numerelor exacte din JavaScript
    const big = exactLineValue(1_000_000_000, MAX_QUANTITY);
    expect(big).toBe(1_000_000_000n * MAX_QUANTITY);
    expect(big > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("față de referința independentă (fracții exacte), pe 800 de perechi aleatorii", () => {
    const rnd = prng(31337);
    for (let i = 0; i < 800; i++) {
      const price = Math.floor(rnd() * 5_000_000);
      const qty = quantityFromTicks(BigInt(Math.floor(rnd() * 1e9)));
      const exact = Fraction.of(String(price)).times(
        Fraction.of(formatQuantity(qty, { minDecimals: 4 })),
      );
      const scaled = exactLineValue(price, qty);
      // scaled / 10^4 trebuie să fie exact valoarea în bani
      expect(new Fraction(scaled, 10_000n).equals(exact)).toBe(true);
      const split = splitScaledMoney(scaled);
      expect(split.wholeMinor).toBe(exact.n / exact.d);
      expect(split.wholeMinor * QUANTITY_FACTOR + split.remainderScaled).toBe(scaled);
    }
  });

  it("oracol cu toFixed pe valori mici (independent de bigint)", () => {
    const rnd = prng(5);
    for (let i = 0; i < 500; i++) {
      const stepText = ((1 + Math.floor(rnd() * 999)) / 100).toFixed(2);
      const n = 1 + Math.floor(rnd() * 99);
      const expected = (n * Number(stepText)).toFixed(4);
      const actual = formatQuantity(stepsToQuantity(n, q(stepText)), { minDecimals: 4 });
      expect(actual.replace(",", ".")).toBe(expected);
    }
  });
});

describe("erori tipate", () => {
  it("QuantityError e o DomainError cu cod stabil și motiv", () => {
    try {
      parseQuantity("abc");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuantityError);
      expect(e).toBeInstanceOf(DomainError);
      expect((e as QuantityError).code).toBe("QUANTITY_INVALID_FORMAT");
      expect((e as QuantityError).reason).toBe("invalid_format");
      expect((e as QuantityError).name).toBe("QuantityError");
    }
  });

  it("mesajele sunt în română și nu conțin cifre crude de bigint (n)", () => {
    const messages = [
      () => parseQuantity("abc"),
      () => parseQuantity("2,03456"),
      () => parseQuantity("-1"),
      () => parseQuantity("999999999999"),
      () => subtractQuantity(q("1"), q("2")),
      () => assertOrderQuantity(q("0"), { step: q("1") }),
      () => assertOrderQuantity(q("1"), { step: q("2") }),
      () => assertOrderQuantity(q("2"), { step: q("2"), minSteps: 3 }),
    ].map((fn) => {
      try {
        fn();
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).toMatch(/[Cc]antitate|Stocul|Valoarea/);
      expect(message).not.toMatch(/\d+n\b/);
    }
  });
});
