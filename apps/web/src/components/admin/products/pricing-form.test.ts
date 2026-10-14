import { describe, expect, it } from "vitest";
import { buildVariantPatch, validatePricing, type PricingValues } from "./pricing-form";

const text = {
  skuRequired: "sku",
  priceInvalid: "preț",
  saleAbovePrice: "redus>întreg",
  windowOrder: "fereastră",
  eanInvalid: "ean",
  warrantyInvalid: "garanție",
};

const base: PricingValues = {
  sku: "P-1",
  price: "199,50",
  salePrice: "",
  saleStartsAt: "",
  saleEndsAt: "",
  ean: "",
  warrantyMonths: "",
};

describe("validarea prețurilor din formular", () => {
  it("sumele se citesc în lei cu cel mult 2 zecimale, fără float", () => {
    expect(validatePricing(base, ["price"], text)).toEqual({});
    expect(validatePricing({ ...base, price: "12,345" }, ["price"], text)).toEqual({
      price: "preț",
    });
    expect(validatePricing({ ...base, price: "abc" }, ["price"], text)).toEqual({ price: "preț" });
    expect(validatePricing({ ...base, price: "" }, ["price"], text)).toEqual({ price: "preț" });
  });

  it("prețul redus nu depășește prețul întreg, și când se schimbă doar prețul întreg", () => {
    const withSale = { ...base, salePrice: "150" };
    expect(validatePricing(withSale, ["salePrice"], text)).toEqual({});
    expect(validatePricing({ ...withSale, salePrice: "250" }, ["salePrice"], text)).toEqual({
      salePrice: "redus>întreg",
    });
    // prețul întreg coboară sub cel redus existent
    expect(validatePricing({ ...withSale, price: "100" }, ["price"], text)).toEqual({
      salePrice: "redus>întreg",
    });
    // egalitatea e permisă
    expect(validatePricing({ ...withSale, salePrice: "199,50" }, ["salePrice"], text)).toEqual({});
  });

  it("data de sfârșit trebuie să fie după cea de început; un capăt gol e liber", () => {
    const window = { ...base, saleStartsAt: "2026-11-01T00:00", saleEndsAt: "2026-10-01T00:00" };
    expect(validatePricing(window, ["saleEndsAt"], text)).toEqual({ saleEndsAt: "fereastră" });
    expect(
      validatePricing({ ...window, saleEndsAt: "2026-11-30T23:59" }, ["saleEndsAt"], text),
    ).toEqual({});
    expect(validatePricing({ ...window, saleEndsAt: "" }, ["saleEndsAt"], text)).toEqual({});
  });

  it("EAN de 8–14 cifre, garanție între 0 și 240 de luni; golul e permis", () => {
    expect(validatePricing({ ...base, ean: "5901234123457" }, ["ean"], text)).toEqual({});
    expect(validatePricing({ ...base, ean: "123" }, ["ean"], text)).toEqual({ ean: "ean" });
    expect(validatePricing({ ...base, ean: "" }, ["ean"], text)).toEqual({});
    expect(validatePricing({ ...base, warrantyMonths: "24" }, ["warrantyMonths"], text)).toEqual(
      {},
    );
    for (const bad of ["-1", "241", "2,5", "abc"]) {
      expect(validatePricing({ ...base, warrantyMonths: bad }, ["warrantyMonths"], text)).toEqual({
        warrantyMonths: "garanție",
      });
    }
  });

  it("nu validează câmpurile neatinse", () => {
    expect(validatePricing({ ...base, price: "abc", sku: "" }, [], text)).toEqual({});
  });
});

describe("cererea de modificare a variantei", () => {
  it("conține doar câmpurile modificate, cu bani întregi", () => {
    const patch = buildVariantPatch({ ...base, price: "1 299,00", salePrice: "999,99" }, [
      "price",
      "salePrice",
    ]);
    expect(patch).toEqual({ price: 129900, salePrice: 99999 });
  });

  it("câmpurile golite devin null; ferestrele goale rămân șir gol (fără limită)", () => {
    const patch = buildVariantPatch(
      { ...base, salePrice: "", ean: "", warrantyMonths: "", saleStartsAt: "", saleEndsAt: "" },
      ["salePrice", "ean", "warrantyMonths", "saleStartsAt", "saleEndsAt"],
    );
    expect(patch).toEqual({
      salePrice: null,
      ean: null,
      warrantyMonths: null,
      saleStartsAt: "",
      saleEndsAt: "",
    });
  });

  it("garanția devine număr întreg; SKU și EAN se taie de spații", () => {
    expect(
      buildVariantPatch({ ...base, sku: "  X-9 ", ean: " 5901234123457 ", warrantyMonths: "36" }, [
        "sku",
        "ean",
        "warrantyMonths",
      ]),
    ).toEqual({ sku: "X-9", ean: "5901234123457", warrantyMonths: 36 });
  });

  it("cheile necunoscute (inclusiv orice cost) nu ajung în cerere", () => {
    expect(buildVariantPatch(base, ["purchase", "costNet"])).toEqual({});
  });
});
