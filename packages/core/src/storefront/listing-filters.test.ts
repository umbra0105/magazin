import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  filtersToParams,
  formatRange,
  hasActiveFilters,
  hasNonCanonicalFilterParams,
  parseListingFilters,
  parseRange,
  withoutFilter,
} from "./listing-filters";

describe("parseRange", () => {
  it("interval, doar minim, doar maxim, valoare exactă", () => {
    expect(parseRange("10-50")).toEqual({ min: 10, max: 50 });
    expect(parseRange("10-")).toEqual({ min: 10, max: null });
    expect(parseRange("-50")).toEqual({ min: null, max: 50 });
    expect(parseRange("12.5")).toEqual({ min: 12.5, max: 12.5 });
    expect(parseRange("2.5-7.25")).toEqual({ min: 2.5, max: 7.25 });
  });

  it("capetele inversate se întorc; textul invalid sau gol dă null", () => {
    expect(parseRange("50-10")).toEqual({ min: 10, max: 50 });
    for (const bad of ["", "-", "abc", "1-2-3", "1e5", "10,5", "--5", "1..2", "99999999999999-1"]) {
      expect(parseRange(bad), bad).toBeNull();
    }
  });

  it("formatRange e inversul lui parseRange", () => {
    for (const text of ["10-50", "10-", "-50", "12.5"]) {
      expect(formatRange(parseRange(text)!)).toBe(text);
    }
  });
});

describe("parseListingFilters", () => {
  it("citește mărcile, intervalele și opțiunile din adresă", () => {
    const filters = parseListingFilters({
      marca: "astralpool,harvia",
      f_debit: "10-50",
      f_material: "opt1,opt2",
      sortare: "new",
      pagina: "2",
    });
    expect(filters).toEqual({
      brands: ["astralpool", "harvia"],
      ranges: { debit: { min: 10, max: 50 } },
      options: { material: ["opt1", "opt2"] },
    });
  });

  it("ignoră valorile invalide, duplicatele și parametrii necunoscuți; nu aruncă", () => {
    const filters = parseListingFilters({
      marca: "OK-NU,a b,x,x,../etc",
      f_debit: "abc",
      "f_cod rau": "1-2",
      f_: "1-2",
      altceva: "1",
    });
    expect(filters.brands).toEqual(["x"]);
    expect(filters.ranges).toEqual({});
    // un text care nu e interval ajunge la opțiuni; la interogare se ignoră dacă atributul nu e de tip listă sau opțiunea nu există
    expect(filters.options).toEqual({ debit: ["abc"] });
    expect(parseListingFilters({})).toEqual(EMPTY_FILTERS);
  });

  it("limitează numărul de elemente dintr-o listă", () => {
    const many = Array.from({ length: 50 }, (_, i) => `m${i}`).join(",");
    expect(parseListingFilters({ marca: many }).brands).toHaveLength(20);
  });

  it("acceptă parametrul repetat (tablou) luând primul", () => {
    expect(parseListingFilters({ f_debit: ["1-2", "5-6"] }).ranges["debit"]).toEqual({
      min: 1,
      max: 2,
    });
  });
});

describe("forme de formular (fără JavaScript)", () => {
  it("min_/max_ separate devin interval; marca repetată devine listă; virgula zecimală e acceptată", () => {
    const params = { marca: ["a", "b"], min_debit: "10", max_debit: "50,5", min_putere: "3" };
    expect(parseListingFilters(params)).toEqual({
      brands: ["a", "b"],
      ranges: { debit: { min: 10, max: 50.5 }, putere: { min: 3, max: null } },
      options: {},
    });
    expect(hasNonCanonicalFilterParams(params)).toBe(true);
    expect(hasNonCanonicalFilterParams({ marca: "a,b", f_debit: "1-2" })).toBe(false);
  });

  it("casete goale și text invalid se ignoră; f_ are prioritate față de min_/max_", () => {
    expect(parseListingFilters({ min_debit: "", max_debit: "" }).ranges).toEqual({});
    expect(parseListingFilters({ min_debit: "abc" }).ranges).toEqual({});
    expect(parseListingFilters({ f_debit: "1-2", min_debit: "5" }).ranges["debit"]).toEqual({
      min: 1,
      max: 2,
    });
  });
});

describe("filtersToParams / withoutFilter / hasActiveFilters", () => {
  const filters = parseListingFilters({ marca: "b,a", f_debit: "10-50", f_material: "z,y" });

  it("adresă stabilă: aceleași filtre, aceeași ordine", () => {
    expect(filtersToParams(filters)).toEqual([
      ["marca", "a,b"],
      ["f_debit", "10-50"],
      ["f_material", "y,z"],
    ]);
    expect(
      filtersToParams(parseListingFilters(Object.fromEntries(filtersToParams(filters)))),
    ).toEqual(filtersToParams(filters));
  });

  it("scoate un singur filtru: o marcă, un interval sau o opțiune", () => {
    expect(withoutFilter(filters, { kind: "brand", slug: "a" }).brands).toEqual(["b"]);
    expect(withoutFilter(filters, { kind: "range", code: "debit" }).ranges).toEqual({});
    expect(withoutFilter(filters, { kind: "option", code: "material", id: "z" }).options).toEqual({
      material: ["y"],
    });
    expect(
      withoutFilter(withoutFilter(filters, { kind: "option", code: "material", id: "z" }), {
        kind: "option",
        code: "material",
        id: "y",
      }).options,
    ).toEqual({});
    // nu modifică originalul
    expect(filters.brands).toEqual(["b", "a"]);
  });

  it("hasActiveFilters", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters)).toBe(true);
  });
});
