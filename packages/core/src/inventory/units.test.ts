import { describe, expect, it } from "vitest";
import { DEFAULT_MEASURE_UNIT_CODE, INITIAL_MEASURE_UNITS } from "./constants";
import { effectiveMeasureUnit, sameMeasureUnit } from "./units";

const BUC = "unit-buc";
const MP = "unit-mp";
const KG = "unit-kg";

describe("unitatea nulă și «buc» se tratează identic", () => {
  it("unitatea efectivă: varianta, apoi produsul, apoi bucata", () => {
    expect(effectiveMeasureUnit(KG, MP, BUC)).toBe(KG);
    expect(effectiveMeasureUnit(null, MP, BUC)).toBe(MP);
    expect(effectiveMeasureUnit(undefined, MP, BUC)).toBe(MP);
    expect(effectiveMeasureUnit(null, null, BUC)).toBe(BUC);
    expect(effectiveMeasureUnit(null, undefined, BUC)).toBe(BUC);
  });

  it("nulă și «buc» sunt aceeași unitate; alta nu", () => {
    expect(sameMeasureUnit(null, BUC, BUC)).toBe(true);
    expect(sameMeasureUnit(BUC, null, BUC)).toBe(true);
    expect(sameMeasureUnit(undefined, null, BUC)).toBe(true);
    expect(sameMeasureUnit(BUC, BUC, BUC)).toBe(true);
    expect(sameMeasureUnit(null, MP, BUC)).toBe(false);
    expect(sameMeasureUnit(MP, KG, BUC)).toBe(false);
    expect(sameMeasureUnit(MP, MP, BUC)).toBe(true);
  });

  it("«buc» este prima unitate de pornire și nu are zecimale", () => {
    expect(DEFAULT_MEASURE_UNIT_CODE).toBe("buc");
    expect(INITIAL_MEASURE_UNITS[0]).toMatchObject({ code: "buc", decimals: 0 });
  });
});
