import { describe, expect, it } from "vitest";
import { parseSignedDelta, type QuantityDelta } from "@ecom/shared";
import { ADJUSTMENT_REASONS } from "./constants";
import {
  ADJUSTMENT_NOTE_MAX,
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_SIGN_RULES,
  EFFECTIVE_AT_TOLERANCE_MS,
  adjustmentSignProblem,
  effectiveAtProblem,
  fitsUnitPrecision,
} from "./adjustment-rules";

const d = (text: string): QuantityDelta => parseSignedDelta(text);

describe("motivele fixe ale ajustărilor (D8)", () => {
  it("fiecare motiv are etichetă în română și o regulă de semn, și nimic în plus", () => {
    expect(Object.keys(ADJUSTMENT_REASON_LABELS).sort()).toEqual([...ADJUSTMENT_REASONS].sort());
    expect(Object.keys(ADJUSTMENT_SIGN_RULES).sort()).toEqual([...ADJUSTMENT_REASONS].sort());
  });

  it("etichetele sunt exact cele din plan", () => {
    expect(ADJUSTMENT_REASON_LABELS).toEqual({
      sale_in_store: "Vânzare în magazin",
      receipt: "Recepție marfă",
      return: "Retur",
      inventory_correction: "Inventariere (corecție)",
      damaged: "Deteriorat",
      lost_stolen: "Pierdut/Furt",
      other: "Alt motiv",
    });
  });

  it("limita textului liber e 500 de caractere", () => {
    expect(ADJUSTMENT_NOTE_MAX).toBe(500);
  });
});

describe("semnul ajustării după motiv", () => {
  const rows: Array<[(typeof ADJUSTMENT_REASONS)[number], "-" | "+", boolean]> = [
    ["sale_in_store", "-", true],
    ["sale_in_store", "+", false],
    ["damaged", "-", true],
    ["damaged", "+", false],
    ["lost_stolen", "-", true],
    ["lost_stolen", "+", false],
    ["receipt", "+", true],
    ["receipt", "-", false],
    ["return", "+", true],
    ["return", "-", true],
    ["inventory_correction", "+", true],
    ["inventory_correction", "-", true],
    ["other", "+", true],
    ["other", "-", true],
  ];
  it.each(rows)("%s cu %s → permis: %s", (reason, sign, allowed) => {
    const problem = adjustmentSignProblem(reason, d(`${sign}2,5`));
    expect(problem === null).toBe(allowed);
  });

  it("spune în ce sens trebuie să fie ajustarea", () => {
    expect(adjustmentSignProblem("sale_in_store", d("1"))).toBe("must_decrease");
    expect(adjustmentSignProblem("receipt", d("-1"))).toBe("must_increase");
  });
});

describe("precizia unității de măsură", () => {
  // Referință independentă (pe text, fără aritmetica din quantity.ts): ultimele 4 cifre ale valorii în zecimi de miime
  // sunt partea zecimală; contează cifrele până la ultima nenulă
  function fractionDigits(delta: QuantityDelta): number {
    const digits = (delta < 0n ? -delta : delta).toString().padStart(5, "0");
    return digits.slice(-4).replace(/0+$/, "").length;
  }

  it("exemple: 0,5 buc nu, 1 buc da; 41,25 mp (2 zecimale) da, 41,255 nu; kg cu 3 zecimale", () => {
    expect(fitsUnitPrecision(d("1"), 0)).toBe(true);
    expect(fitsUnitPrecision(d("-12"), 0)).toBe(true);
    expect(fitsUnitPrecision(d("0,5"), 0)).toBe(false);
    expect(fitsUnitPrecision(d("-0,0001"), 0)).toBe(false);
    expect(fitsUnitPrecision(d("41,25"), 2)).toBe(true);
    expect(fitsUnitPrecision(d("41,255"), 2)).toBe(false);
    expect(fitsUnitPrecision(d("0,125"), 3)).toBe(true);
    expect(fitsUnitPrecision(d("0,1255"), 3)).toBe(false);
    expect(fitsUnitPrecision(d("0,1255"), 4)).toBe(true);
  });

  it("coincide cu numărarea cifrelor zecimale pe 2000 de valori pseudoaleatoare × 5 niveluri de precizie", () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const magnitude = BigInt(next() % 1_000_000) * (next() % 3 === 0 ? 10_000n : 1n);
      const delta = ((next() % 2 === 0 ? 1n : -1n) * (magnitude % 100_000_000n)) as QuantityDelta;
      for (let decimals = 0; decimals <= 4; decimals++) {
        expect(fitsUnitPrecision(delta, decimals), `${delta} cu ${decimals} zecimale`).toBe(
          fractionDigits(delta) <= decimals,
        );
      }
    }
  });

  it("zecimale în afara 0–4 sunt o eroare de programare", () => {
    expect(() => fitsUnitPrecision(d("1"), -1)).toThrow();
    expect(() => fitsUnitPrecision(d("1"), 5)).toThrow();
    expect(() => fitsUnitPrecision(d("1"), 1.5)).toThrow();
  });
});

describe("ora efectivă", () => {
  const now = new Date("2026-10-22T10:00:00Z");
  const at = (ms: number): Date => new Date(now.getTime() + ms);

  it("trecutul și «acum» sunt în regulă; viitorul peste toleranță nu", () => {
    expect(effectiveAtProblem(now, now)).toBeNull();
    expect(effectiveAtProblem(at(-3 * 24 * 3_600_000), now)).toBeNull();
    expect(effectiveAtProblem(at(EFFECTIVE_AT_TOLERANCE_MS), now)).toBeNull();
    expect(effectiveAtProblem(at(EFFECTIVE_AT_TOLERANCE_MS + 1), now)).toBe("future");
    expect(effectiveAtProblem(at(3_600_000), now)).toBe("future");
  });

  it("toleranța e de un minut (ceasuri ușor nepotrivite)", () => {
    expect(EFFECTIVE_AT_TOLERANCE_MS).toBe(60_000);
  });

  it("o dată invalidă se refuză", () => {
    expect(effectiveAtProblem(new Date("nu e o dată"), now)).toBe("invalid");
  });
});

describe("cantitatea din ajustare e o variație, nu o cantitate de vânzare", () => {
  it("o variație poate fi orice multiplu de zecime de miime; pasul de vânzare nu o limitează", () => {
    // 41,25 e pasul rolei; ajustarea de 1 mp trebuie să treacă regulile pure
    expect(fitsUnitPrecision(d("-1"), 2)).toBe(true);
    expect(fitsUnitPrecision(1n as QuantityDelta, 4)).toBe(true);
  });
});
