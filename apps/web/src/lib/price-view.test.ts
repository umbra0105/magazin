import { describe, expect, it } from "vitest";
import { describePrice, parseQuantity, type PriceDisplayInput, type Quantity } from "@ecom/shared";
import { priceLines } from "./price-view";

/**
 * Textele prețului pe unitate și pe pas (română, moneda din setări). Nu rotunjesc nimic: asamblează valorile funcției pure
 * `describePrice`. «≈» doar când suma nu e exactă; afișarea e marcată provizorie.
 */

const q = (text: string): Quantity => parseQuantity(text);
const fmt = { currency: "RON", locale: "ro-RO" };
/** Intl pune un spațiu «nu se rupe» între sumă și monedă; testele compară cu spațiu obișnuit. */
const plain = (text: string | null): string | null =>
  text === null ? null : text.replace(/\u00A0/g, " ");

function lines(over: Partial<PriceDisplayInput>) {
  const display = describePrice({
    priceMinor: 10_000,
    basis: "unit",
    step: q("1"),
    unitSymbol: "buc",
    stepLabel: null,
    showStepPrice: false,
    ...over,
  });
  const out = priceLines(display, fmt);
  return {
    ...out,
    reference: plain(out.reference),
    perUnit: plain(out.perUnit),
    stepPrice: plain(out.stepPrice),
  };
}

describe("textele prețului", () => {
  it("bisulfat: «120,00 RON / sac de 25 kg» și «(4,80 RON/kg)», fără «≈»", () => {
    expect(
      lines({
        priceMinor: 12_000,
        basis: "step",
        step: q("25"),
        unitSymbol: "kg",
        stepLabel: "sac",
      }),
    ).toMatchObject({
      reference: "120,00 RON / sac de 25 kg",
      perUnit: "(4,80 RON/kg)",
      stepPrice: null,
    });
  });

  it("liner: «87,35 RON / mp» și «Rolă de 41,25 mp ≈ 3.603,19 RON»", () => {
    expect(
      lines({
        priceMinor: 8_735,
        step: q("41,25"),
        unitSymbol: "mp",
        stepLabel: "rolă",
        showStepPrice: true,
      }),
    ).toMatchObject({
      reference: "87,35 RON / mp",
      perUnit: null,
      stepPrice: "Rolă de 41,25 mp ≈ 3.603,19 RON",
    });
  });

  it("suma exactă folosește «=», cea neexactă «≈»", () => {
    expect(
      lines({ priceMinor: 3_600, step: q("2,5"), unitSymbol: "ml", showStepPrice: true }).stepPrice,
    ).toBe("Pas de 2,5 ml = 90,00 RON");
    expect(
      lines({
        priceMinor: 14_990,
        step: q("2,03"),
        unitSymbol: "mp",
        stepLabel: "cutie",
        showStepPrice: true,
      }).stepPrice,
    ).toBe("Cutie de 2,03 mp ≈ 304,30 RON");
  });

  it("preț pe unitate neexact: «(≈ 33,33 RON/kg)»; fără denumire: «/ 3 kg»", () => {
    expect(
      lines({ priceMinor: 10_000, basis: "step", step: q("3"), unitSymbol: "kg" }),
    ).toMatchObject({
      reference: "100,00 RON / 3 kg",
      perUnit: "(≈ 33,33 RON/kg)",
    });
  });

  it("produs la bucată: «199,00 RON / buc», nimic în plus", () => {
    expect(lines({ priceMinor: 19_900 })).toEqual({
      reference: "199,00 RON / buc",
      per: "buc",
      perUnit: null,
      stepPrice: null,
      provisional: true,
    });
  });

  it("denumirea cu majusculă doar în fața lui «de» (nu se modifică restul)", () => {
    expect(
      lines({
        priceMinor: 4_500,
        step: q("1,8"),
        unitSymbol: "ml",
        stepLabel: "bucată",
        showStepPrice: true,
      }).stepPrice,
    ).toBe("Bucată de 1,8 ml = 81,00 RON");
  });

  it("afișarea e mereu marcată provizoriu", () => {
    expect(lines({}).provisional).toBe(true);
  });
});
