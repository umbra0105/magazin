import { describe, expect, it } from "vitest";
import {
  groupIssues,
  orderGroupSnapshot,
  toPriceGroup,
  toPublicGroupView,
  validateGroupFields,
  type CustomerGroupRecord,
} from "./group-rules";

const base = {
  name: "Client fidel",
  pricingType: "discount" as const,
  discountBps: 500,
  markupBps: null,
  stacksWithSalePrice: false,
  earnsLoyaltyPoints: true,
  tone: "success" as const,
  isActive: true,
};

const record = (over: Partial<CustomerGroupRecord> = {}): CustomerGroupRecord => ({
  id: "g1",
  slug: "client-fidel",
  isSystem: false,
  sortOrder: 1,
  ...base,
  ...over,
});

describe("validateGroupFields", () => {
  it("acceptă tipurile valide", () => {
    expect(validateGroupFields(base).discountBps).toBe(500);
    expect(
      validateGroupFields({ name: "Partener 1", pricingType: "cost_plus", markupBps: 1200 }),
    ).toMatchObject({ pricingType: "cost_plus", markupBps: 1200, earnsLoyaltyPoints: true });
    expect(validateGroupFields({ name: "Standard", pricingType: "none" }).tone).toBe("neutral");
    expect(validateGroupFields({ ...base, discountBps: 0 }).discountBps).toBe(0);
  });

  it.each([
    ["nume gol", { ...base, name: "   " }],
    ["tip necunoscut", { ...base, pricingType: "special" }],
    ["reducere lipsă", { ...base, discountBps: null }],
    ["reducere peste 100%", { ...base, discountBps: 10_001 }],
    ["reducere negativă", { ...base, discountBps: -1 }],
    ["reducere fracționară", { ...base, discountBps: 500.5 }],
    ["adaos la tip «discount»", { ...base, markupBps: 1200 }],
    ["«none» cu reducere", { name: "x", pricingType: "none", discountBps: 100 }],
    ["«cost_plus» fără adaos", { name: "x", pricingType: "cost_plus" }],
    [
      "«cost_plus» cu reducere",
      { name: "x", pricingType: "cost_plus", markupBps: 1, discountBps: 5 },
    ],
    [
      "cumul la «cost_plus»",
      { name: "x", pricingType: "cost_plus", markupBps: 100, stacksWithSalePrice: true },
    ],
    ["cumul la «none»", { name: "x", pricingType: "none", stacksWithSalePrice: true }],
    ["ton necunoscut", { ...base, tone: "#ff0000" }],
    ["câmp în plus", { ...base, costPrice: 1 }],
  ])("refuză: %s", (_label, input) => {
    expect(() => validateGroupFields(input)).toThrowError(
      expect.objectContaining({ code: "CUSTOMER_GROUP_INVALID" }),
    );
  });

  it("groupIssues indică câmpul greșit", () => {
    expect(
      groupIssues({
        pricingType: "discount",
        discountBps: null,
        markupBps: null,
        stacksWithSalePrice: false,
      }),
    ).toEqual([{ field: "discountBps", message: "Alege procentul reducerii." }]);
  });
});

describe("toPriceGroup", () => {
  it("fără grup sau «none» = prețul public", () => {
    expect(toPriceGroup(null)).toEqual({ pricingType: "none" });
    expect(toPriceGroup(record({ pricingType: "none", discountBps: null }))).toEqual({
      pricingType: "none",
    });
  });

  it("«discount» păstrează procentul și cumularea", () => {
    expect(toPriceGroup(record({ stacksWithSalePrice: true }))).toEqual({
      pricingType: "discount",
      discountBps: 500,
      stacksWithSalePrice: true,
    });
  });

  it("«cost_plus» păstrează adaosul", () => {
    expect(
      toPriceGroup(record({ pricingType: "cost_plus", discountBps: null, markupBps: 1700 })),
    ).toEqual({ pricingType: "cost_plus", markupBps: 1700 });
  });

  it("un grup stricat (tip fără procent) se refuză, nu se ghicește", () => {
    expect(() => toPriceGroup(record({ discountBps: null }))).toThrow();
    expect(() =>
      toPriceGroup(record({ pricingType: "cost_plus", discountBps: null, markupBps: null })),
    ).toThrow();
  });
});

describe("proiecția publică și snapshot-ul comenzii", () => {
  it("vitrina află tipul și reducerea, dar NICIODATĂ adaosul", () => {
    const partner = toPublicGroupView(
      record({ name: "Partener 1", pricingType: "cost_plus", discountBps: null, markupBps: 1200 }),
    );
    expect(partner).toEqual({ name: "Partener 1", pricingType: "cost_plus", discountBps: null });
    expect(JSON.stringify(partner)).not.toMatch(/markup|1200/i);
    expect(toPublicGroupView(record())).toEqual({
      name: "Client fidel",
      pricingType: "discount",
      discountBps: 500,
    });
  });

  it("snapshot: fără grup = none; discount și cost_plus păstrează doar procentul lor", () => {
    expect(orderGroupSnapshot(null)).toEqual({
      customerGroupId: null,
      groupPricingType: "none",
      groupDiscountBps: null,
      groupMarkupBps: null,
    });
    expect(orderGroupSnapshot(record())).toEqual({
      customerGroupId: "g1",
      groupPricingType: "discount",
      groupDiscountBps: 500,
      groupMarkupBps: null,
    });
    expect(
      orderGroupSnapshot(record({ pricingType: "cost_plus", discountBps: null, markupBps: 2100 })),
    ).toEqual({
      customerGroupId: "g1",
      groupPricingType: "cost_plus",
      groupDiscountBps: null,
      groupMarkupBps: 2100,
    });
  });
});
