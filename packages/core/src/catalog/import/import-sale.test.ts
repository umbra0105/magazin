import { describe, expect, it } from "vitest";
import { parseSaleValues, type ImportUnit } from "./import-sale";

/**
 * Faza 5, punctul 9b: citirea coloanelor de vânzare din fișierul de import (unitate, bază, pas, minim, denumire, conversie
 * SmartBill, stare stoc, termen). Funcții PURE; mesajele sunt în română și numesc câmpul. Fără `float`: pasul și raportul trec
 * doar prin `Quantity`.
 */

const units: ImportUnit[] = [
  { id: "u-buc", code: "buc", name: "Bucată", symbol: "buc", decimals: 0, isActive: true },
  { id: "u-mp", code: "mp", name: "Metru pătrat", symbol: "mp", decimals: 2, isActive: true },
  { id: "u-ml", code: "ml", name: "Metru liniar", symbol: "ml", decimals: 1, isActive: true },
  { id: "u-kg", code: "kg", name: "Kilogram", symbol: "kg", decimals: 3, isActive: true },
  {
    id: "u-vechi",
    code: "vechi",
    name: "Unitate veche",
    symbol: "uv",
    decimals: 0,
    isActive: false,
  },
  // două unități cu același simbol: ambiguu
  { id: "u-x1", code: "x1", name: "Prima", symbol: "set", decimals: 0, isActive: true },
  { id: "u-x2", code: "x2", name: "A doua", symbol: "set", decimals: 0, isActive: true },
];

const parse = (values: Record<string, string | null>) => parseSaleValues(values, units);
const errorsOf = (values: Record<string, string | null>) =>
  parse(values).errors.map((e) => `${e.field}: ${e.text}`);

describe("unitatea de măsură", () => {
  it("după simbol, nume sau cod, fără diferență de majuscule sau diacritice", () => {
    for (const text of ["mp", "MP", "Metru pătrat", "metru patrat", "METRU PĂTRAT"]) {
      const out = parse({ unit: text });
      expect(out.errors, text).toEqual([]);
      expect(out.sale.unit).toMatchObject({ id: "u-mp", decimals: 2 });
    }
  });

  it("«buc» (simbol, nume sau cod) și «-» înseamnă la bucată: id nul", () => {
    for (const text of ["buc", "Bucată", "bucata"]) {
      expect(parse({ unit: text }).sale.unit, text).toMatchObject({ id: null, decimals: 0 });
    }
    expect(parse({ unit: null }).sale.unit).toMatchObject({ id: null, decimals: 0 });
  });

  it("necunoscută, ambiguă sau dezactivată: eroare cu motiv", () => {
    expect(errorsOf({ unit: "litri" })).toEqual([
      expect.stringContaining("unit: unitatea „litri” nu există"),
    ]);
    expect(errorsOf({ unit: "set" })).toEqual([expect.stringContaining("mai multe unități")]);
    expect(errorsOf({ unit: "uv" })).toEqual([expect.stringContaining("dezactivată")]);
  });

  it("celula goală nu produce nimic", () => {
    expect(parse({}).sale).toEqual({});
    expect(parse({}).errors).toEqual([]);
  });
});

describe("baza prețului", () => {
  it("«Pe unitate» și «Pe pas», cu variante de scriere", () => {
    for (const text of ["Pe unitate", "pe unitate", "unitate", "unit"]) {
      expect(parse({ priceBasis: text }).sale.priceBasis, text).toBe("unit");
    }
    for (const text of ["Pe pas", "PE PAS", "pas", "step"]) {
      expect(parse({ priceBasis: text }).sale.priceBasis, text).toBe("step");
    }
    expect(errorsOf({ priceBasis: "pe litru" })).toEqual([
      expect.stringContaining("priceBasis: valoare necunoscută"),
    ]);
  });

  it("nu se poate șterge cu «-» (nu e un câmp care poate fi nul)", () => {
    expect(errorsOf({ priceBasis: null })).toEqual([expect.stringContaining("priceBasis")]);
  });
});

describe("pasul de vânzare", () => {
  it("virgulă sau punct; zecimi de miime exacte, fără float", () => {
    expect(parse({ saleStep: "41,25" }).sale.saleStep).toBe(412_500);
    expect(parse({ saleStep: "2.03" }).sale.saleStep).toBe(20_300);
    expect(parse({ saleStep: "0,0001" }).sale.saleStep).toBe(1);
    expect(parse({ saleStep: "25" }).sale.saleStep).toBe(250_000);
    expect(parse({ saleStep: null }).sale.saleStep).toBeNull();
  });

  it("refuză text, zero, negativ, prea multe zecimale (mai mult de 4) și prea mare", () => {
    for (const bad of ["abc", "0", "-3", "1,23456", "2147483648", "1,2,3", "1 2"]) {
      expect(errorsOf({ saleStep: bad }), bad).toEqual([expect.stringContaining("saleStep")]);
    }
  });
});

describe("minimul în pași", () => {
  it("număr întreg 1–1.000.000; «-» = un pas", () => {
    expect(parse({ minSteps: "2" }).sale.minSteps).toBe(2);
    expect(parse({ minSteps: "1000000" }).sale.minSteps).toBe(1_000_000);
    expect(parse({ minSteps: null }).sale.minSteps).toBeNull();
    for (const bad of ["0", "1000001", "1,5", "abc", "-1"]) {
      expect(errorsOf({ minSteps: bad }), bad).toEqual([expect.stringContaining("minSteps")]);
    }
  });
});

describe("denumirea pasului", () => {
  it("tăiată la capete, cel mult 30 de caractere; «-» o șterge", () => {
    expect(parse({ saleStepLabel: "sac" }).sale.saleStepLabel).toBe("sac");
    expect(parse({ saleStepLabel: "x".repeat(30) }).sale.saleStepLabel).toHaveLength(30);
    expect(parse({ saleStepLabel: null }).sale.saleStepLabel).toBeNull();
    expect(errorsOf({ saleStepLabel: "x".repeat(31) })).toEqual([
      expect.stringContaining("cel mult 30"),
    ]);
  });
});

describe("conversia SmartBill", () => {
  it("modul: «Aceeași unitate», «Pași», «Raport»; «-» îl șterge", () => {
    expect(parse({ smartbillMode: "Aceeași unitate" }).sale.smartbillMode).toBe("same_unit");
    expect(parse({ smartbillMode: "aceeasi unitate" }).sale.smartbillMode).toBe("same_unit");
    expect(parse({ smartbillMode: "Pași" }).sale.smartbillMode).toBe("steps");
    expect(parse({ smartbillMode: "Raport" }).sale.smartbillMode).toBe("ratio");
    expect(parse({ smartbillMode: null }).sale.smartbillMode).toBeNull();
    expect(errorsOf({ smartbillMode: "altceva" })).toEqual([
      expect.stringContaining("smartbillMode: valoare necunoscută"),
    ]);
  });

  it("raportul: cantitate pozitivă cu cel mult 4 zecimale, exact", () => {
    expect(parse({ smartbillRatio: "41,25" }).sale.smartbillRatio).toBe(412_500);
    expect(parse({ smartbillRatio: "25" }).sale.smartbillRatio).toBe(250_000);
    expect(parse({ smartbillRatio: null }).sale.smartbillRatio).toBeNull();
    for (const bad of ["0", "-1", "abc", "1,23456"]) {
      expect(errorsOf({ smartbillRatio: bad }), bad).toEqual([
        expect.stringContaining("smartbillRatio"),
      ]);
    }
  });

  it("numele unității SmartBill: cel mult 40 de caractere", () => {
    expect(parse({ smartbillUnitName: " rola " }).sale.smartbillUnitName).toBe("rola");
    expect(parse({ smartbillUnitName: null }).sale.smartbillUnitName).toBeNull();
    expect(errorsOf({ smartbillUnitName: "x".repeat(41) })).toEqual([
      expect.stringContaining("cel mult 40"),
    ]);
  });
});

describe("starea stocului și termenul de livrare", () => {
  it("«În stoc», «Stoc epuizat», «La comandă» (și variante); alt text: eroare; nu se șterge", () => {
    expect(parse({ stockStatus: "În stoc" }).sale.stockStatus).toBe("instock");
    expect(parse({ stockStatus: "in stoc" }).sale.stockStatus).toBe("instock");
    expect(parse({ stockStatus: "Stoc epuizat" }).sale.stockStatus).toBe("outofstock");
    expect(parse({ stockStatus: "epuizat" }).sale.stockStatus).toBe("outofstock");
    expect(parse({ stockStatus: "La comandă" }).sale.stockStatus).toBe("onbackorder");
    expect(errorsOf({ stockStatus: "poate" })).toEqual([
      expect.stringContaining("stockStatus: valoare necunoscută"),
    ]);
    expect(errorsOf({ stockStatus: null })).toEqual([expect.stringContaining("stockStatus")]);
  });

  it("termenul: zile întregi 0–365; «-» = termenul brandului/magazinului", () => {
    expect(parse({ leadTimeDays: "0" }).sale.leadTimeDays).toBe(0);
    expect(parse({ leadTimeDays: "365" }).sale.leadTimeDays).toBe(365);
    expect(parse({ leadTimeDays: null }).sale.leadTimeDays).toBeNull();
    for (const bad of ["366", "-1", "1,5", "abc", "1000"]) {
      expect(errorsOf({ leadTimeDays: bad }), bad).toEqual([
        expect.stringContaining("leadTimeDays"),
      ]);
    }
  });
});

describe("mai multe coloane deodată", () => {
  it("toate erorile sunt raportate (nu doar prima), fiecare cu câmpul ei", () => {
    const out = parse({ unit: "litri", saleStep: "abc", minSteps: "0", stockStatus: "poate" });
    expect(out.errors.map((e) => e.field).sort()).toEqual([
      "minSteps",
      "saleStep",
      "stockStatus",
      "unit",
    ]);
  });
});
