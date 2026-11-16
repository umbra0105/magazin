import { describe, expect, it } from "vitest";
import {
  DEFAULT_LISTING_SORT,
  MAX_LISTING_PAGE,
  pageWindow,
  parseListingPage,
  parseListingSort,
} from "./listing-query";

describe("parseListingSort", () => {
  it("acceptă doar sortările cunoscute; restul cad pe implicit", () => {
    expect(parseListingSort("price_asc")).toBe("price_asc");
    expect(parseListingSort("new")).toBe("new");
    for (const bad of [undefined, null, "", "PRICE_ASC", "price", "'; drop table", 3, ["new"]]) {
      expect(parseListingSort(bad)).toBe(DEFAULT_LISTING_SORT);
    }
  });
});

describe("parseListingPage", () => {
  it("întreg pozitiv; orice altceva → 1; plafonat", () => {
    expect(parseListingPage("3")).toBe(3);
    expect(parseListingPage(["4", "9"])).toBe(4);
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "01", " 2", "99999"]) {
      expect(parseListingPage(bad), String(bad)).toBe(1);
    }
    expect(parseListingPage("1500")).toBe(MAX_LISTING_PAGE);
  });
});

describe("pageWindow", () => {
  it("calculează numărul de pagini și decalajul", () => {
    expect(pageWindow(1, 50, 24)).toEqual({ page: 1, pageCount: 3, offset: 0, outOfRange: false });
    expect(pageWindow(3, 50, 24)).toEqual({ page: 3, pageCount: 3, offset: 48, outOfRange: false });
  });

  it("o listă goală are o singură pagină; pagina 2 a ei e în afara limitelor", () => {
    expect(pageWindow(1, 0, 24)).toMatchObject({ pageCount: 1, outOfRange: false });
    expect(pageWindow(2, 0, 24)).toMatchObject({ outOfRange: true });
  });

  it("exact o pagină plină nu creează o pagină în plus", () => {
    expect(pageWindow(1, 24, 24)).toMatchObject({ pageCount: 1 });
    expect(pageWindow(2, 24, 24)).toMatchObject({ outOfRange: true });
    expect(pageWindow(2, 25, 24)).toMatchObject({ pageCount: 2, outOfRange: false });
  });
});
