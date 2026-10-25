import { describe, expect, it } from "vitest";
import { effectiveSale, previewVariantPrice } from "./price-preview";

/**
 * Previzualizarea «Cum se afișează prețul» din tabul Prețuri: valorile EFECTIVE ale variantei (varianta peste produs peste
 * «buc»), apoi textele prețului pe unitate și pe pas. Afișare provizorie.
 */

const mp = { id: "u-mp", symbol: "mp" };
const kg = { id: "u-kg", symbol: "kg" };
const units = [mp, kg];
const product = {
  measureUnitId: null as string | null,
  priceBasis: "unit",
  saleStep: null as number | null,
  saleStepLabel: null as string | null,
  showStepPrice: false,
};
const variant = {
  price: 8_735,
  salePrice: null as number | null,
  measureUnitId: null as string | null,
  priceBasis: null as string | null,
  saleStep: null as number | null,
};
const fmt = { currency: "RON", locale: "ro-RO" };
const plain = (text: string | null) => text?.replace(/\u00A0/g, " ") ?? null;

describe("valorile efective ale variantei", () => {
  it("nimic setat: «buc», pe unitate, un pas de o unitate", () => {
    expect(effectiveSale(variant, product, units)).toEqual({
      unitSymbol: null,
      basis: "unit",
      step: null,
    });
  });

  it("produsul dă unitatea, baza și pasul; varianta le suprascrie", () => {
    const p = { ...product, measureUnitId: "u-mp", saleStep: 412_500 };
    expect(effectiveSale(variant, p, units)).toEqual({
      unitSymbol: "mp",
      basis: "unit",
      step: 412_500,
    });
    const v = { ...variant, measureUnitId: "u-kg", priceBasis: "step", saleStep: 250_000 };
    expect(effectiveSale(v, p, units)).toEqual({ unitSymbol: "kg", basis: "step", step: 250_000 });
    // doar pasul suprascris: unitatea rămâne a produsului
    expect(effectiveSale({ ...variant, saleStep: 20_000 }, p, units)).toEqual({
      unitSymbol: "mp",
      basis: "unit",
      step: 20_000,
    });
  });

  it("o unitate necunoscută (ștearsă între timp) cade pe «buc», nu produce un simbol inventat", () => {
    expect(
      effectiveSale(variant, { ...product, measureUnitId: "u-lipsa" }, units).unitSymbol,
    ).toBeNull();
  });
});

describe("previzualizarea unei variante", () => {
  it("liner: prețul întreg și, separat, cel redus, fiecare cu unitatea lui", () => {
    const p = {
      ...product,
      measureUnitId: "u-mp",
      saleStep: 412_500,
      saleStepLabel: "rolă",
      showStepPrice: true,
    };
    const out = previewVariantPrice({ ...variant, salePrice: 7_000 }, p, units, fmt);
    expect(plain(out.price.reference)).toBe("87,35 RON / mp");
    expect(plain(out.price.stepPrice)).toBe("Rolă de 41,25 mp ≈ 3.603,19 RON");
    expect(plain(out.sale?.reference ?? null)).toBe("70,00 RON / mp");
    expect(plain(out.sale?.stepPrice ?? null)).toBe("Rolă de 41,25 mp = 2.887,50 RON");
  });

  it("bisulfat: pe pas, cu prețul pe kg lângă", () => {
    const p = {
      ...product,
      measureUnitId: "u-kg",
      priceBasis: "step",
      saleStep: 250_000,
      saleStepLabel: "sac",
    };
    const out = previewVariantPrice({ ...variant, price: 12_000 }, p, units, fmt);
    expect(plain(out.price.reference)).toBe("120,00 RON / sac de 25 kg");
    expect(plain(out.price.perUnit)).toBe("(4,80 RON/kg)");
    expect(out.sale).toBeNull();
  });

  it("produs la bucată: «87,35 RON / buc», fără linii în plus", () => {
    const out = previewVariantPrice(variant, product, units, fmt);
    expect(plain(out.price.reference)).toBe("87,35 RON / buc");
    expect(out.price.perUnit).toBeNull();
    expect(out.price.stepPrice).toBeNull();
  });
});
