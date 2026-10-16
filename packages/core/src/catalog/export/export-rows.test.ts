import { describe, expect, it } from "vitest";
import { IMPORT_FIELDS } from "../import/import-fields";
import { templateRows } from "../import/import-template";
import {
  cellToCsvText,
  exportHeaders,
  formatLei,
  productRows,
  type ExportProductData,
} from "./export-rows";

const product: ExportProductData = {
  id: "prod1",
  title: "Pompă 100",
  subtitle: null,
  description: "Linia 1\nLinia 2",
  slug: "pompa-100",
  status: "draft",
  shippingClass: "pallet",
  brandName: null,
  categoryPaths: ["Pompe > Circulație", "Accesorii"],
  updatedAt: new Date("2026-10-17T11:35:07Z"),
  variants: [
    {
      sku: "P-1",
      ean: "0012345678905",
      price: 129_950,
      salePrice: null,
      warrantyMonths: 24,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    },
    {
      sku: "P-2",
      ean: null,
      price: 5,
      salePrice: 3,
      warrantyMonths: null,
      weightGrams: 4200,
      lengthMm: 500,
      widthMm: 300,
      heightMm: 400,
    },
  ],
};

const stamp = (date: Date): string => `T:${date.toISOString()}`;

describe("antetele exportului", () => {
  it("sunt exact ale șablonului de import, în aceeași ordine, plus două coloane doar pentru citire", () => {
    const headers = exportHeaders();
    expect(headers.slice(0, IMPORT_FIELDS.length)).toEqual(templateRows()[0]);
    expect(headers.slice(IMPORT_FIELDS.length)).toEqual(["ID produs", "Modificat la"]);
  });
});

describe("rândurile produsului", () => {
  it("câte un rând pe variantă, cu câmpurile produsului repetate", () => {
    const rows = productRows(product, stamp);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.length === exportHeaders().length)).toBe(true);
    const [first, second] = rows.map((r) => r.map(cellToCsvText));
    const sku = 0;
    const title = 1;
    expect([first?.[sku], second?.[sku]]).toEqual(["P-1", "P-2"]);
    expect([first?.[title], second?.[title]]).toEqual(["Pompă 100", "Pompă 100"]);
  });

  it("valorile: lei cu virgulă, întregi, goale pentru lipsă, etichete în română, căile de categorii", () => {
    const [first, second] = productRows(product, stamp).map((r) => r.map(cellToCsvText));
    const header = exportHeaders();
    const at = (row: string[] | undefined, label: string): string | undefined =>
      row?.[header.indexOf(label)];
    expect(at(first, "Preț (lei, cu TVA)")).toBe("1299,50");
    expect(at(first, "Preț promoțional (lei, cu TVA)")).toBe("");
    expect(at(second, "Preț (lei, cu TVA)")).toBe("0,05");
    expect(at(second, "Preț promoțional (lei, cu TVA)")).toBe("0,03");
    expect(at(first, "EAN")).toBe("0012345678905");
    expect(at(second, "EAN")).toBe("");
    expect(at(first, "Garanție (luni)")).toBe("24");
    expect(at(second, "Greutate (g)")).toBe("4200");
    expect(at(second, "Înălțime (mm)")).toBe("400");
    expect(at(first, "Subtitlu")).toBe("");
    expect(at(first, "Brand")).toBe("");
    expect(at(first, "Clasă de livrare")).toBe("Paletizat");
    expect(at(first, "Stare")).toBe("Ciornă");
    expect(at(first, "Categorii")).toBe("Pompe > Circulație | Accesorii");
    expect(at(first, "Descriere")).toBe("Linia 1\nLinia 2");
    expect(at(first, "ID produs")).toBe("prod1");
    expect(at(first, "Modificat la")).toBe("T:2026-10-17T11:35:07.000Z");
  });

  it("un produs fără variante nu are rânduri", () => {
    expect(productRows({ ...product, variants: [] }, stamp)).toEqual([]);
  });

  it("niciun tip de celulă nu poartă un câmp de cost", () => {
    const serialized = JSON.stringify(productRows(product, stamp));
    expect(serialized).not.toMatch(/cost/i);
  });
});

describe("formatLei", () => {
  it("scrie bani ca lei cu virgulă și două zecimale, fără separator de mii", () => {
    expect(formatLei(0)).toBe("0,00");
    expect(formatLei(1)).toBe("0,01");
    expect(formatLei(100)).toBe("1,00");
    expect(formatLei(129_950)).toBe("1299,50");
    expect(formatLei(1_000_000_000)).toBe("10000000,00");
  });
});
