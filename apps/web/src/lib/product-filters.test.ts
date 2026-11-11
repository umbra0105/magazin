import { describe, expect, it } from "vitest";
import { parseProductListQuery, type ProductListQuery } from "@ecom/core";
import { activeProductFilters, panelFilterCount } from "./product-filters";

/** Etichetele eliminabile de sub bara de filtre a listei de produse (docs/17 §4.1): doar filtrele active, fiecare cu legătura care îl scoate. */

const base: ProductListQuery = parseProductListQuery({});
const lookups = {
  categories: [
    { id: "c1", label: "Pompe" },
    { id: "c2", label: "  Pompe de căldură" },
  ],
  brands: [{ id: "b1", name: "Acme" }],
};

describe("activeProductFilters", () => {
  it("fără filtre nu există etichete; sortarea, rândurile pe pagină și pagina nu sunt filtre", () => {
    expect(activeProductFilters(base, lookups)).toEqual([]);
    expect(
      activeProductFilters({ ...base, sort: "title_asc", pageSize: 50, page: 3 }, lookups),
    ).toEqual([]);
  });

  it("fiecare filtru are etichetă în română (cu numele categoriei/brandului, fără indentare), cheie și nume accesibil", () => {
    const filters = activeProductFilters(
      {
        ...base,
        q: "liner",
        categoryId: "c2",
        brandId: "b1",
        status: "active",
        shippingClass: "oversized",
        stock: "onbackorder",
      },
      lookups,
    );
    expect(filters.map((f) => f.key)).toEqual([
      "q",
      "category",
      "brand",
      "status",
      "shipping",
      "stock",
    ]);
    expect(filters.map((f) => f.label)).toEqual([
      "Căutare: liner",
      "Categorie: Pompe de căldură",
      "Brand: Acme",
      "Stare: Activ",
      "Clasă de livrare: Supradimensionat",
      "Stoc: La comandă",
    ]);
    expect(filters[1]?.removeLabel).toBe("Elimină filtrul Categorie: Pompe de căldură");
  });

  it("legătura scoate DOAR filtrul ei, păstrează restul, vederea, sortarea și rândurile pe pagină, și duce la pagina 1", () => {
    const filters = activeProductFilters(
      {
        ...base,
        view: "deleted",
        q: "liner",
        status: "draft",
        sort: "title_asc",
        pageSize: 50,
        page: 4,
      },
      lookups,
    );
    expect(filters.map((f) => f.href)).toEqual([
      "/admin/produse?view=deleted&status=draft&sort=title_asc&size=50",
      "/admin/produse?view=deleted&q=liner&sort=title_asc&size=50",
    ]);
  });

  it("o categorie sau un brand care nu mai există în listă: eticheta nu dispare (arată identificatorul), ca filtrul să se poată scoate", () => {
    const filters = activeProductFilters({ ...base, categoryId: "sters", brandId: "b9" }, lookups);
    expect(filters.map((f) => f.label)).toEqual(["Categorie: sters", "Brand: b9"]);
    expect(filters[0]?.href).toBe("/admin/produse?brand=b9");
  });
});

describe("panelFilterCount", () => {
  it("numără filtrele din spatele butonului «Filtre» (categorie, brand, stare, livrare, stoc); căutarea e mereu vizibilă și nu se numără", () => {
    expect(panelFilterCount(activeProductFilters(base, lookups))).toBe(0);
    expect(panelFilterCount(activeProductFilters({ ...base, q: "liner" }, lookups))).toBe(0);
    expect(
      panelFilterCount(
        activeProductFilters(
          { ...base, q: "liner", categoryId: "c1", brandId: "b1", status: "active" },
          lookups,
        ),
      ),
    ).toBe(3);
    expect(
      panelFilterCount(
        activeProductFilters(
          {
            ...base,
            categoryId: "c1",
            brandId: "b1",
            status: "active",
            shippingClass: "pallet",
            stock: "instock",
          },
          lookups,
        ),
      ),
    ).toBe(5);
  });
});
