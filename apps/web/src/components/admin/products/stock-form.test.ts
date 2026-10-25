import { describe, expect, it } from "vitest";
import {
  buildProductStockPatch,
  buildVariantStockPatch,
  effectiveLeadTime,
  effectiveManage,
  manageChoice,
  manageValue,
  parseLeadTimeInput,
  parseStepLabelInput,
  type StockTexts,
} from "./stock-form";

const texts: StockTexts = {
  leadTimeInvalid: "termen invalid",
  leadTimeTooLong: "termen prea lung",
  labelTooLong: "denumire prea lungă",
};

describe("termenul de livrare scris de utilizator", () => {
  it("număr întreg de zile 0–365; gol = nul (se aplică brandul sau setarea globală)", () => {
    expect(parseLeadTimeInput("", texts)).toEqual({ ok: true, value: null });
    expect(parseLeadTimeInput("   ", texts)).toEqual({ ok: true, value: null });
    expect(parseLeadTimeInput("0", texts)).toEqual({ ok: true, value: 0 });
    expect(parseLeadTimeInput(" 14 ", texts)).toEqual({ ok: true, value: 14 });
    expect(parseLeadTimeInput("365", texts)).toEqual({ ok: true, value: 365 });
  });

  it("refuză ce nu e număr întreg și ce depășește 365, cu mesaje diferite", () => {
    for (const bad of ["abc", "1,5", "1.5", "-1", "+3", "1e2", "٣", "0x10"]) {
      expect(parseLeadTimeInput(bad, texts), bad).toEqual({
        ok: false,
        message: texts.leadTimeInvalid,
      });
    }
    for (const long of ["366", "1000", "99999"]) {
      expect(parseLeadTimeInput(long, texts), long).toEqual({
        ok: false,
        message: texts.leadTimeTooLong,
      });
    }
  });
});

describe("denumirea pasului", () => {
  it("tăiată la capete; gol = fără denumire; cel mult 30 de caractere", () => {
    expect(parseStepLabelInput("  sac ", texts)).toEqual({ ok: true, value: "sac" });
    expect(parseStepLabelInput("", texts)).toEqual({ ok: true, value: null });
    expect(parseStepLabelInput("   ", texts)).toEqual({ ok: true, value: null });
    expect(parseStepLabelInput("x".repeat(30), texts)).toEqual({ ok: true, value: "x".repeat(30) });
    expect(parseStepLabelInput("x".repeat(31), texts)).toEqual({
      ok: false,
      message: texts.labelTooLong,
    });
    // lungimea se numără după tăiere, nu cu spațiile de la capete
    expect(parseStepLabelInput(` ${"x".repeat(30)} `, texts)).toEqual({
      ok: true,
      value: "x".repeat(30),
    });
  });
});

describe("suprascrierea gestiunii pe variantă", () => {
  it("nul = moștenește, true = gestionat, false = negestionat; dus-întors", () => {
    expect(manageChoice(null)).toBe("inherit");
    expect(manageChoice(true)).toBe("managed");
    expect(manageChoice(false)).toBe("unmanaged");
    for (const choice of ["inherit", "managed", "unmanaged"] as const) {
      expect(manageChoice(manageValue(choice))).toBe(choice);
    }
  });

  it("gestiunea efectivă: varianta peste produs", () => {
    expect(effectiveManage(true, "inherit")).toBe(true);
    expect(effectiveManage(false, "inherit")).toBe(false);
    expect(effectiveManage(true, "unmanaged")).toBe(false);
    expect(effectiveManage(false, "managed")).toBe(true);
  });
});

describe("cererea către server (doar câmpurile modificate)", () => {
  const values = {
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: true,
    leadTimeDays: "10",
  };

  it("produsul: trimite doar ce s-a schimbat; termenul devine număr, golul devine null", () => {
    expect(buildProductStockPatch(values, ["allowBackorder"], texts)).toEqual({
      ok: true,
      patch: { allowBackorder: true },
    });
    expect(buildProductStockPatch(values, ["leadTimeDays"], texts)).toEqual({
      ok: true,
      patch: { leadTimeDays: 10 },
    });
    expect(
      buildProductStockPatch({ ...values, leadTimeDays: "" }, ["leadTimeDays"], texts),
    ).toEqual({
      ok: true,
      patch: { leadTimeDays: null },
    });
    expect(buildProductStockPatch(values, ["manageStock", "stockStatus"], texts)).toEqual({
      ok: true,
      patch: { manageStock: true, stockStatus: "instock" },
    });
  });

  it("termen invalid: nimic de trimis, eroarea e la câmpul lui; un termen nemodificat nu se validează", () => {
    expect(
      buildProductStockPatch({ ...values, leadTimeDays: "400" }, ["leadTimeDays"], texts),
    ).toEqual({
      ok: false,
      errors: { leadTimeDays: texts.leadTimeTooLong },
    });
    // câmpul nemodificat și invalid (valoare veche) nu blochează salvarea altui câmp
    expect(
      buildProductStockPatch({ ...values, leadTimeDays: "zzz" }, ["allowBackorder"], texts),
    ).toEqual({
      ok: true,
      patch: { allowBackorder: true },
    });
  });

  it("varianta: alegerea devine true/false/null, disponibilitatea goală devine null (moștenește)", () => {
    expect(
      buildVariantStockPatch({ manage: "unmanaged", status: "outofstock" }, ["manage", "status"]),
    ).toEqual({
      manageStock: false,
      stockStatus: "outofstock",
    });
    expect(buildVariantStockPatch({ manage: "inherit", status: "" }, ["manage", "status"])).toEqual(
      {
        manageStock: null,
        stockStatus: null,
      },
    );
    expect(buildVariantStockPatch({ manage: "managed", status: "" }, ["manage"])).toEqual({
      manageStock: true,
    });
    expect(
      buildVariantStockPatch({ manage: "managed", status: "onbackorder" }, ["status"]),
    ).toEqual({
      stockStatus: "onbackorder",
    });
  });
});

describe("termenul care se aplică acum (live, pe valoarea din câmp)", () => {
  const context = { brandDays: 8, brandName: "Hayward", globalDays: 14 };

  it("produsul bate brandul, brandul bate setarea globală; 0 e o valoare", () => {
    expect(effectiveLeadTime(3, context)).toEqual({ days: 3, origin: "product", brandName: null });
    expect(effectiveLeadTime(0, context)).toEqual({ days: 0, origin: "product", brandName: null });
    expect(effectiveLeadTime(null, context)).toEqual({
      days: 8,
      origin: "brand",
      brandName: "Hayward",
    });
    expect(effectiveLeadTime(null, { ...context, brandDays: null })).toEqual({
      days: 14,
      origin: "global",
      brandName: null,
    });
    expect(effectiveLeadTime(null, { ...context, brandDays: 0 })).toEqual({
      days: 0,
      origin: "brand",
      brandName: "Hayward",
    });
  });
});
