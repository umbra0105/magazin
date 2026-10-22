import { describe, expect, it } from "vitest";
import {
  buildVariantSalePatch,
  formatMinimum,
  formatStepInput,
  parseMinInput,
  parseStepInput,
  previewQuantities,
  validateVariantSale,
  type SaleTexts,
  type VariantSaleValues,
} from "./sale-form";

const texts: SaleTexts = {
  stepInvalid: "pas invalid",
  stepDecimals: (n) => `pas cu cel mult ${n} zecimale`,
  stepPositive: "pas pozitiv",
  stepTooBig: "pas prea mare",
  minInvalid: "minim invalid",
  ratioInvalid: "raport invalid",
  ratioMissing: "raport lipsă",
};

describe("pasul de vânzare scris de utilizator", () => {
  it("virgulă sau punct, în limita zecimalelor unității; gol = nul", () => {
    expect(parseStepInput("2,03", 2, texts)).toEqual({ ok: true, value: 20_300 });
    expect(parseStepInput("2.03", 2, texts)).toEqual({ ok: true, value: 20_300 });
    expect(parseStepInput("41,25", 2, texts)).toEqual({ ok: true, value: 412_500 });
    expect(parseStepInput("25", 0, texts)).toEqual({ ok: true, value: 250_000 });
    expect(parseStepInput("2,5", 1, texts)).toEqual({ ok: true, value: 25_000 });
    expect(parseStepInput("", 2, texts)).toEqual({ ok: true, value: null });
    expect(parseStepInput("   ", 2, texts)).toEqual({ ok: true, value: null });
  });

  it("refuză: prea multe zecimale (inclusiv 5 la o unitate cu 4), zero, negativ, text, prea mare", () => {
    expect(parseStepInput("2,03456", 4, texts)).toEqual({
      ok: false,
      message: "pas cu cel mult 4 zecimale",
    });
    expect(parseStepInput("2,5", 0, texts)).toEqual({
      ok: false,
      message: "pas cu cel mult 0 zecimale",
    });
    expect(parseStepInput("2,031", 2, texts)).toEqual({
      ok: false,
      message: "pas cu cel mult 2 zecimale",
    });
    expect(parseStepInput("0", 2, texts)).toEqual({ ok: false, message: "pas pozitiv" });
    expect(parseStepInput("0,00", 2, texts)).toEqual({ ok: false, message: "pas pozitiv" });
    expect(parseStepInput("-2", 2, texts)).toEqual({ ok: false, message: "pas invalid" });
    expect(parseStepInput("abc", 2, texts)).toEqual({ ok: false, message: "pas invalid" });
    expect(parseStepInput("1.234,5", 2, texts)).toEqual({ ok: false, message: "pas invalid" });
    expect(parseStepInput("214749", 0, texts)).toEqual({ ok: false, message: "pas prea mare" });
    expect(parseStepInput("214748", 0, texts)).toEqual({ ok: true, value: 2_147_480_000 });
    expect(parseStepInput("99999999999", 0, texts)).toEqual({
      ok: false,
      message: "pas prea mare",
    });
  });

  it("afișarea pasului salvat și dus-întors", () => {
    expect(formatStepInput(null)).toBe("");
    expect(formatStepInput(20_300)).toBe("2,03");
    expect(formatStepInput(412_500)).toBe("41,25");
    for (const step of [1, 25_000, 20_300, 412_500, 250_000, 2_147_483_647]) {
      const shown = formatStepInput(step);
      expect(parseStepInput(shown, 4, texts)).toEqual({ ok: true, value: step });
    }
  });
});

describe("minimul în pași", () => {
  it("număr întreg ≥ 1 sau gol", () => {
    expect(parseMinInput("", texts)).toEqual({ ok: true, value: null });
    expect(parseMinInput("2", texts)).toEqual({ ok: true, value: 2 });
    expect(parseMinInput("1000000", texts)).toEqual({ ok: true, value: 1_000_000 });
    for (const bad of ["0", "-1", "1,5", "abc", "1000001"]) {
      expect(parseMinInput(bad, texts), bad).toEqual({ ok: false, message: "minim invalid" });
    }
  });
});

describe("previzualizarea cantităților posibile", () => {
  it("multiplii pasului, exacți, cu virgulă (cele 6 produse)", () => {
    expect(previewQuantities(20_300)).toEqual(["2,03", "4,06", "6,09", "8,12"]); // mozaic
    expect(previewQuantities(412_500)).toEqual(["41,25", "82,5", "123,75", "165"]); // liner
    expect(previewQuantities(25_000)).toEqual(["2,5", "5", "7,5", "10"]); // țeavă
    expect(previewQuantities(250_000)).toEqual(["25", "50", "75", "100"]); // bisulfat
    expect(previewQuantities(10_000)).toEqual(["1", "2", "3", "4"]); // furtun
    expect(previewQuantities(null)).toEqual(["1", "2", "3", "4"]);
    expect(previewQuantities(18_000, 3)).toEqual(["1,8", "3,6", "5,4"]); // abachi
  });
});

describe("cantitatea minimă afișată", () => {
  it("minim × pas, exact; depășirea plafonului nu se afișează", () => {
    expect(formatMinimum(20_300, 2)).toBe("4,06");
    expect(formatMinimum(412_500, 3)).toBe("123,75");
    expect(formatMinimum(null, 5)).toBe("5");
    expect(formatMinimum(2_147_483_647, 1_000_000)).toBeNull();
  });
});

describe("varianta: pas, minim și conversia SmartBill", () => {
  const base: VariantSaleValues = {
    saleStep: "",
    minSteps: "",
    smartbillMode: "",
    smartbillUnitName: "",
    smartbillRatio: "",
  };

  it("fără modificări, nimic de trimis și nicio eroare", () => {
    expect(validateVariantSale(base, [], 2, texts)).toEqual({});
    expect(buildVariantSalePatch(base, [], 2, texts)).toEqual({ ok: true, patch: {} });
  });

  it("trimite doar ce s-a schimbat, cu tipurile corecte; golul devine nul", () => {
    const values = { ...base, saleStep: "1,8", minSteps: "2" };
    expect(buildVariantSalePatch(values, ["saleStep", "minSteps"], 1, texts)).toEqual({
      ok: true,
      patch: { saleStep: 18_000, minSteps: 2 },
    });
    expect(buildVariantSalePatch(base, ["saleStep", "minSteps"], 1, texts)).toEqual({
      ok: true,
      patch: { saleStep: null, minSteps: null },
    });
  });

  it("raport SmartBill: rolă = 41,25 mp; trece mereu modul și raportul împreună", () => {
    const values = {
      ...base,
      smartbillMode: "ratio",
      smartbillRatio: "41,25",
      smartbillUnitName: "rolă",
    };
    expect(
      buildVariantSalePatch(
        values,
        ["smartbillMode", "smartbillRatio", "smartbillUnitName"],
        2,
        texts,
      ),
    ).toEqual({
      ok: true,
      patch: { smartbillMode: "ratio", smartbillRatio: 412_500, smartbillUnitName: "rolă" },
    });
    // la alt mod, raportul se șterge (una setată, una nulă nu există)
    expect(
      buildVariantSalePatch({ ...values, smartbillMode: "steps" }, ["smartbillMode"], 2, texts),
    ).toEqual({ ok: true, patch: { smartbillMode: "steps", smartbillRatio: null } });
    expect(buildVariantSalePatch({ ...base }, ["smartbillMode"], 2, texts)).toEqual({
      ok: true,
      patch: { smartbillMode: null, smartbillRatio: null },
    });
  });

  it("erori pe câmp: pas, minim, raport lipsă sau invalid", () => {
    expect(validateVariantSale({ ...base, saleStep: "2,5" }, ["saleStep"], 0, texts)).toEqual({
      saleStep: "pas cu cel mult 0 zecimale",
    });
    expect(validateVariantSale({ ...base, minSteps: "0" }, ["minSteps"], 2, texts)).toEqual({
      minSteps: "minim invalid",
    });
    expect(
      validateVariantSale({ ...base, smartbillMode: "ratio" }, ["smartbillMode"], 2, texts),
    ).toEqual({ smartbillRatio: "raport lipsă" });
    expect(
      validateVariantSale(
        { ...base, smartbillMode: "ratio", smartbillRatio: "abc" },
        ["smartbillRatio"],
        2,
        texts,
      ),
    ).toEqual({ smartbillRatio: "raport invalid" });
    expect(
      validateVariantSale(
        { ...base, smartbillMode: "ratio", smartbillRatio: "0" },
        ["smartbillRatio"],
        2,
        texts,
      ),
    ).toEqual({ smartbillRatio: "raport invalid" });
    // nu se validează ce nu s-a atins
    expect(validateVariantSale({ ...base, saleStep: "abc" }, ["minSteps"], 2, texts)).toEqual({});
  });
});
