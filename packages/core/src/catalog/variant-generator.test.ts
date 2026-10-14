import { describe, expect, it } from "vitest";
import {
  buildSkus,
  combinationKey,
  generateCombinations,
  MAX_VARIANTS_PER_PRODUCT,
  normalizeOptions,
  planVariantSync,
  VariantGenerationError,
} from "./variant-generator";

const size = { name: "Mărime", values: ["S", "M", "L"] };
const color = { name: "Culoare", values: ["Roșu", "Albastru"] };

describe("generateCombinations", () => {
  it("produsul cartezian, în ordinea opțiunilor și a valorilor", () => {
    const combos = generateCombinations([size, color]);
    expect(combos).toHaveLength(6);
    expect(combos.map((c) => c.selections.map((s) => s.value).join("/"))).toEqual([
      "S/Roșu",
      "S/Albastru",
      "M/Roșu",
      "M/Albastru",
      "L/Roșu",
      "L/Albastru",
    ]);
    expect(combos[0]?.selections).toEqual([
      { option: "Mărime", value: "S" },
      { option: "Culoare", value: "Roșu" },
    ]);
  });

  it("o singură opțiune dă o variantă per valoare", () => {
    expect(generateCombinations([size])).toHaveLength(3);
  });

  it("curăță spațiile și ignoră dublurile (fără diferență de majuscule) și valorile goale", () => {
    const clean = normalizeOptions([{ name: "  Mărime ", values: ["S", " s ", "", "M", "m"] }]);
    expect(clean).toEqual([{ name: "Mărime", values: ["S", "M"] }]);
  });

  it("cheia combinației nu depinde de majuscule sau de spații", () => {
    const a = combinationKey([{ option: "Mărime", value: "S" }]);
    const b = combinationKey([{ option: " MĂRIME", value: "s " }]);
    expect(a).toBe(b);
  });

  it("refuză: fără opțiuni, nume gol, nume duplicat, opțiune fără valori, prea multe opțiuni sau valori", () => {
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(VariantGenerationError);
        return (e as VariantGenerationError).code;
      }
      return "nicio eroare";
    };
    expect(code(() => generateCombinations([]))).toBe("CATALOG_OPTIONS_EMPTY");
    expect(code(() => generateCombinations([{ name: " ", values: ["a"] }]))).toBe(
      "CATALOG_OPTION_NAME_EMPTY",
    );
    expect(
      code(() =>
        generateCombinations([
          { name: "Culoare", values: ["a"] },
          { name: "culoare", values: ["b"] },
        ]),
      ),
    ).toBe("CATALOG_OPTION_DUPLICATE");
    expect(code(() => generateCombinations([{ name: "X", values: ["", " "] }]))).toBe(
      "CATALOG_OPTION_VALUES_EMPTY",
    );
    expect(
      code(() =>
        generateCombinations(["a", "b", "c", "d"].map((name) => ({ name, values: ["1"] }))),
      ),
    ).toBe("CATALOG_OPTIONS_LIMIT");
    expect(
      code(() =>
        generateCombinations([
          { name: "X", values: Array.from({ length: 51 }, (_, i) => `v${i}`) },
        ]),
      ),
    ).toBe("CATALOG_OPTION_VALUES_LIMIT");
  });

  it("limita de variante: peste prag se refuză cu numărul de combinații în mesaj", () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(() =>
      generateCombinations([
        { name: "A", values: values(11) },
        { name: "B", values: values(10) },
      ]),
    ).toThrow(/110 variante/);
    // exact la limită trece
    expect(
      generateCombinations([
        { name: "A", values: values(10) },
        { name: "B", values: values(10) },
      ]),
    ).toHaveLength(MAX_VARIANTS_PER_PRODUCT);
  });
});

describe("buildSkus", () => {
  const combos = generateCombinations([size, color]);

  it("BAZĂ-VALOARE1-VALOARE2, majuscule, fără diacritice, toate unice", () => {
    const skus = buildSkus("pompa-x", combos);
    expect(skus.slice(0, 2)).toEqual(["POMPA-X-S-ROSU", "POMPA-X-S-ALBASTRU"]);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it("evită SKU-urile deja existente (fără diferență de majuscule) cu sufix numeric", () => {
    const skus = buildSkus("pompa-x", combos, new Set(["pompa-x-s-rosu"]));
    expect(skus[0]).toBe("POMPA-X-S-ROSU-2");
    expect(skus[1]).toBe("POMPA-X-S-ALBASTRU");
  });

  it("două valori care dau același SKU primesc sufixe diferite", () => {
    const tricky = generateCombinations([{ name: "Tip", values: ["Ș", "S"] }]);
    const skus = buildSkus("A", tricky);
    expect(skus).toEqual(["A-S", "A-S-2"]);
  });

  it("refuză codul de bază gol", () => {
    expect(() => buildSkus("  ", combos)).toThrow(VariantGenerationError);
  });
});

describe("planVariantSync", () => {
  it("creează doar combinațiile lipsă și raportează (fără să șteargă) variantele rămase fără combinație", () => {
    const desired = generateCombinations([size, color]);
    const existing = [
      combinationKey([
        { option: "Mărime", value: "S" },
        { option: "Culoare", value: "Roșu" },
      ]),
      combinationKey([
        { option: "Mărime", value: "XXL" },
        { option: "Culoare", value: "Roșu" },
      ]),
    ];
    const plan = planVariantSync(desired, existing);
    expect(plan.toCreate).toHaveLength(5);
    expect(plan.existing).toHaveLength(1);
    expect(plan.orphaned).toEqual([existing[1]]);
  });

  it("fără modificări: nimic de creat", () => {
    const desired = generateCombinations([size]);
    const plan = planVariantSync(
      desired,
      desired.map((d) => d.key),
    );
    expect(plan).toEqual({ toCreate: [], existing: desired.map((d) => d.key), orphaned: [] });
  });
});
