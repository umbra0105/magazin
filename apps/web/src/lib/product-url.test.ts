import { describe, expect, it } from "vitest";
import { parseProductListQuery, type ProductListQuery } from "@ecom/core";
import { productsHref } from "./product-url";

/** Adresa listei de produse: aceiași parametri pe care îi citește nucleul (`parseProductListQuery`). */

const base: ProductListQuery = parseProductListQuery({});

describe("productsHref", () => {
  it("fără filtre: adresa goală; valorile implicite (sortare, 25 pe pagină, pagina 1) nu se scriu", () => {
    expect(productsHref(base)).toBe("/admin/produse");
    expect(productsHref({ ...base, page: 1, pageSize: 25, sort: "updated_desc" })).toBe(
      "/admin/produse",
    );
  });

  it("ordinea parametrilor: view, q, category, brand, status, shipping, stock, sort, size, page", () => {
    expect(
      productsHref({
        ...base,
        view: "deleted",
        q: "pompă",
        categoryId: "c1",
        brandId: "b1",
        status: "active",
        shippingClass: "oversized",
        stock: "instock",
        sort: "title_asc",
        pageSize: 50,
        page: 3,
      }),
    ).toBe(
      "/admin/produse?view=deleted&q=pomp%C4%83&category=c1&brand=b1&status=active&shipping=oversized&stock=instock&sort=title_asc&size=50&page=3",
    );
  });

  it("pagina și rândurile pe pagină date explicit bat valorile din interogare", () => {
    expect(productsHref({ ...base, q: "a", page: 2 }, { page: 5 })).toBe(
      "/admin/produse?q=a&page=5",
    );
    expect(productsHref({ ...base, q: "a", page: 2 }, { page: 1 })).toBe("/admin/produse?q=a");
    expect(productsHref({ ...base, pageSize: 25 }, { pageSize: 100 })).toBe(
      "/admin/produse?size=100",
    );
    expect(productsHref({ ...base, pageSize: 100 }, { pageSize: 25 })).toBe("/admin/produse");
  });

  it("schimbarea rândurilor pe pagină duce la prima pagină (pagina veche ar putea să nu mai existe)", () => {
    expect(productsHref({ ...base, page: 4 }, { pageSize: 50 })).toBe("/admin/produse?size=50");
  });

  it("adresa construită aici o citește nucleul înapoi, neschimbată", () => {
    const queries: ProductListQuery[] = [
      { ...base, q: "pompă cu ghilimele", status: "draft", page: 2 },
      { ...base, view: "deleted", q: "x&y=z", sort: "status_asc", pageSize: 100 },
      {
        ...base,
        categoryId: "cat_1",
        brandId: "brand-2",
        shippingClass: "pallet",
        stock: "outofstock",
      },
      base,
    ];
    for (const query of queries) {
      const url = new URL(productsHref(query), "http://x");
      expect(
        parseProductListQuery(Object.fromEntries(url.searchParams)),
        JSON.stringify(query),
      ).toEqual(query);
    }
  });
});
