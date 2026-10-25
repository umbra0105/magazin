import { describe, expect, it } from "vitest";
import { describePrice, type PriceDisplayInput } from "./price-display";
import { parseQuantity, type Quantity } from "./quantity";

/**
 * Faza 5, punctul 9b: afișarea prețului pe unitate și pe pas. Funcție PURĂ, PROVIZORIE (aparține motorului de prețuri din
 * Faza 8): «≈» e doar text informativ, suma afișată e cea exactă rotunjită la 2 zecimale (half-up), iar nimic de aici nu se
 * salvează sau intră în coș. Cele 6 produse-model din plan sunt cazurile principale; restul le verifică un oracol cu fracții
 * întregi, independent de implementare.
 */

const q = (text: string): Quantity => parseQuantity(text);

function input(
  over: Omit<Partial<PriceDisplayInput>, "step"> & { step?: string },
): PriceDisplayInput {
  const { step, ...rest } = over;
  return {
    priceMinor: 10_000,
    basis: "unit",
    step: q(step ?? "1"),
    unitSymbol: "buc",
    stepLabel: null,
    showStepPrice: false,
    ...rest,
  };
}

describe("cele 6 produse-model", () => {
  it("bisulfat de sodiu: 120,00 pe sac de 25 kg, baza «pe pas»: referința pe sac și, lângă, 4,80/kg exact", () => {
    const d = describePrice(
      input({ priceMinor: 12_000, basis: "step", step: "25", unitSymbol: "kg", stepLabel: "sac" }),
    );
    expect(d.reference).toEqual({
      amount: { minor: 12_000n, exact: true },
      per: { kind: "step", step: q("25"), label: "sac", symbol: "kg" },
    });
    expect(d.perUnit).toEqual({ minor: 480n, exact: true });
    expect(d.stepPrice).toBeNull();
    expect(d.provisional).toBe(true);
  });

  it("liner: 87,35/mp, rola de 41,25 mp ≈ 3.603,19 (exact 3.603,1875)", () => {
    const d = describePrice(
      input({
        priceMinor: 8_735,
        step: "41,25",
        unitSymbol: "mp",
        stepLabel: "rolă",
        showStepPrice: true,
      }),
    );
    expect(d.reference).toEqual({
      amount: { minor: 8_735n, exact: true },
      per: { kind: "unit", symbol: "mp" },
    });
    expect(d.perUnit).toBeNull();
    expect(d.stepPrice).toEqual({
      amount: { minor: 360_319n, exact: false },
      step: q("41,25"),
      label: "rolă",
      symbol: "mp",
    });
  });

  it("mozaic: cutia de 2,03 mp la 149,90/mp ≈ 304,30 (exact 304,297)", () => {
    const d = describePrice(
      input({
        priceMinor: 14_990,
        step: "2,03",
        unitSymbol: "mp",
        stepLabel: "cutie",
        showStepPrice: true,
      }),
    );
    expect(d.stepPrice?.amount).toEqual({ minor: 30_430n, exact: false });
  });

  it("țeavă (pas 2,5 ml) fără «arată prețul pasului»: doar referința pe ml", () => {
    const d = describePrice(input({ priceMinor: 3_600, step: "2,5", unitSymbol: "ml" }));
    expect(d.reference.per).toEqual({ kind: "unit", symbol: "ml" });
    expect(d.stepPrice).toBeNull();
    expect(d.perUnit).toBeNull();
  });

  it("țeavă cu prețul pasului: 2,5 ml × 36,00 = 90,00 exact", () => {
    const d = describePrice(
      input({ priceMinor: 3_600, step: "2,5", unitSymbol: "ml", showStepPrice: true }),
    );
    expect(d.stepPrice).toEqual({
      amount: { minor: 9_000n, exact: true },
      step: q("2,5"),
      label: null,
      symbol: "ml",
    });
  });

  it("furtun (pas 1 ml) și produs la bucată: pasul de o unitate nu repetă prețul", () => {
    const furtun = describePrice(
      input({ priceMinor: 590, step: "1", unitSymbol: "ml", showStepPrice: true }),
    );
    expect(furtun.stepPrice).toBeNull();
    expect(furtun.reference.per).toEqual({ kind: "unit", symbol: "ml" });
    const buc = describePrice(input({ priceMinor: 19_900 }));
    expect(buc.reference).toEqual({
      amount: { minor: 19_900n, exact: true },
      per: { kind: "unit", symbol: "buc" },
    });
  });

  it("abachi: pe variantă, bucata de 1,8 ml la 45,00/ml = 81,00 exact", () => {
    const d = describePrice(
      input({
        priceMinor: 4_500,
        step: "1,8",
        unitSymbol: "ml",
        stepLabel: "bucată",
        showStepPrice: true,
      }),
    );
    expect(d.stepPrice).toMatchObject({ amount: { minor: 8_100n, exact: true }, label: "bucată" });
  });
});

describe("baza «pe pas»", () => {
  it("preț pe unitate neexact: 100,00 pe 3 kg = 33,33/kg ≈", () => {
    const d = describePrice(
      input({ priceMinor: 10_000, basis: "step", step: "3", unitSymbol: "kg" }),
    );
    expect(d.perUnit).toEqual({ minor: 3_333n, exact: false });
  });

  it("jumătate de ban rotunjește în sus, doar la afișare (2,5 bani → 3)", () => {
    const d = describePrice(
      input({ priceMinor: 1, step: "2,5", unitSymbol: "ml", showStepPrice: true }),
    );
    expect(d.stepPrice?.amount).toEqual({ minor: 3n, exact: false });
  });

  it("pasul de o unitate cu baza «pe pas» se tratează ca pe unitate (nimic de împărțit)", () => {
    const d = describePrice(
      input({ priceMinor: 2_500, basis: "step", step: "1", unitSymbol: "buc" }),
    );
    expect(d.reference.per).toEqual({ kind: "unit", symbol: "buc" });
    expect(d.perUnit).toBeNull();
  });
});

describe("exactitate pe o grilă (oracol cu fracții întregi, independent de implementare)", () => {
  const prices = [1, 2, 7, 99, 100, 3_600, 8_735, 12_000, 14_990, 123_456, 1_000_000_000];
  const steps = ["0,0001", "0,3", "0,5", "1", "1,5", "2,03", "2,5", "3", "25", "41,25", "214748"];

  it("prețul pasului (baza pe unitate): rotunjit half-up la ban; «exact» ⇔ fără rest", () => {
    for (const price of prices) {
      for (const step of steps) {
        const ticks = BigInt(q(step));
        const p = BigInt(price);
        const shown = describePrice(
          input({ priceMinor: price, step, unitSymbol: "x", showStepPrice: true }),
        );
        if (ticks === 10_000n) {
          expect(shown.stepPrice, `${price}×${step}`).toBeNull();
          continue;
        }
        // preț × pas, în bani: p × ticks / 10⁴; half-up = floor((2·p·ticks + 10⁴) / (2·10⁴))
        const expected = (2n * p * ticks + 10_000n) / 20_000n;
        expect(shown.stepPrice?.amount.minor, `${price}×${step}`).toBe(expected);
        expect(shown.stepPrice?.amount.exact, `${price}×${step}`).toBe(
          (p * ticks) % 10_000n === 0n,
        );
      }
    }
  });

  it("prețul pe unitate (baza pe pas): rotunjit half-up la ban; «exact» ⇔ fără rest", () => {
    for (const price of prices) {
      for (const step of steps) {
        const ticks = BigInt(q(step));
        if (ticks === 10_000n) continue;
        const p = BigInt(price);
        const shown = describePrice(
          input({ priceMinor: price, basis: "step", step, unitSymbol: "x" }),
        );
        // preț pe unitate = p ÷ (ticks/10⁴) = p·10⁴ / ticks; half-up = floor((2·p·10⁴ + ticks) / (2·ticks))
        const expected = (2n * p * 10_000n + ticks) / (2n * ticks);
        expect(shown.perUnit?.minor, `${price}/${step}`).toBe(expected);
        expect(shown.perUnit?.exact, `${price}/${step}`).toBe((p * 10_000n) % ticks === 0n);
      }
    }
  });

  it("referința e mereu prețul introdus, exact", () => {
    for (const price of prices) {
      for (const basis of ["unit", "step"] as const) {
        const d = describePrice(input({ priceMinor: price, basis, step: "2,5", unitSymbol: "x" }));
        expect(d.reference.amount).toEqual({ minor: BigInt(price), exact: true });
      }
    }
  });
});

describe("intrări invalide: refuz clar, nu o valoare inventată", () => {
  it("preț negativ, neîntreg sau nesigur; pas zero", () => {
    for (const priceMinor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => describePrice(input({ priceMinor }))).toThrow();
    }
    expect(() => describePrice(input({ basis: "step", step: "0" }))).toThrow();
  });

  it("nu depinde de ordinea cheilor și nu modifică intrarea", () => {
    const original = input({
      priceMinor: 8_735,
      step: "41,25",
      unitSymbol: "mp",
      showStepPrice: true,
    });
    const snapshot = JSON.stringify(original, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    describePrice(original);
    expect(JSON.stringify(original, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      snapshot,
    );
  });
});
