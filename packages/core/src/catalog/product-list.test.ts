import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_LIST_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  parseProductListQuery,
} from "./product-list";

describe("parseProductListQuery", () => {
  it("implicit: fără filtre, pagina 1, 25 pe pagină, cele mai recent modificate", () => {
    expect(parseProductListQuery({})).toEqual({
      q: "",
      categoryId: null,
      brandId: null,
      status: null,
      shippingClass: null,
      stock: null,
      page: 1,
      pageSize: DEFAULT_PRODUCT_LIST_PAGE_SIZE,
      sort: "updated_desc",
      view: "active",
    });
  });

  it("vederea „deleted” (coșul de gunoi) se recunoaște; orice altceva revine la „active”", () => {
    expect(parseProductListQuery({ view: "deleted" }).view).toBe("deleted");
    expect(parseProductListQuery({ view: ["deleted", "x"] }).view).toBe("deleted");
    for (const view of ["all", "trash", "", "DELETED", "deleted; drop"]) {
      expect(parseProductListQuery({ view }).view, view).toBe("active");
    }
  });

  it("citește filtrele valide, inclusiv valori în array (primul)", () => {
    expect(
      parseProductListQuery({
        q: "  pompă 12kW ",
        category: "cat_1",
        brand: ["brand_1", "x"],
        status: "active",
        shipping: "pallet",
        stock: "outofstock",
        page: "3",
        size: "50",
        sort: "title_asc",
        view: "deleted",
      }),
    ).toEqual({
      q: "pompă 12kW",
      categoryId: "cat_1",
      brandId: "brand_1",
      status: "active",
      shippingClass: "pallet",
      stock: "outofstock",
      page: 3,
      pageSize: 50,
      sort: "title_asc",
      view: "deleted",
    });
  });

  it("ignoră valorile nevalide (revine la implicit), fără să arunce", () => {
    const q = parseProductListQuery({
      status: "published",
      shipping: "freight",
      stock: "lowstock",
      page: "-4",
      size: "5000",
      sort: "price_desc; drop table product",
      category: "../etc/passwd",
      brand: "a b",
    });
    expect(q).toMatchObject({
      status: null,
      shippingClass: null,
      stock: null,
      page: 1,
      pageSize: DEFAULT_PRODUCT_LIST_PAGE_SIZE,
      sort: "updated_desc",
      categoryId: null,
      brandId: null,
    });
  });

  it("costul nu poate fi cerut prin URL: nicio sortare sau filtrare după cost nu e recunoscută", () => {
    for (const params of [
      { sort: "cost_asc" },
      { sort: "costPrice_desc" },
      { sort: "cost" },
      { costPrice: "100" },
      { cost: "1", costMin: "1", costMax: "9" },
    ]) {
      const q = parseProductListQuery(params);
      expect(q.sort).toBe("updated_desc");
      expect(JSON.stringify(q).toLowerCase()).not.toContain("cost");
    }
  });

  it("căutarea se taie la lungimea maximă", () => {
    expect(parseProductListQuery({ q: "a".repeat(500) }).q).toHaveLength(MAX_SEARCH_LENGTH);
  });
});
