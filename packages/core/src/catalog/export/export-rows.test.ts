import { describe, expect, it } from "vitest";
import { IMPORT_FIELDS } from "../import/import-fields";
import { templateRows } from "../import/import-template";
import {
  cellToCsvText,
  exportHeaders,
  formatLei,
  productRows,
  unitLabels,
  type ExportProductData,
  type ExportVariantSale,
} from "./export-rows";

/** Produs la bucată: nimic setat (unitate «buc», pe unitate, un pas, fără conversie SmartBill). */
const DEFAULT_SALE: ExportVariantSale = {
  unitSymbol: null,
  priceBasis: "unit",
  saleStep: null,
  minSteps: null,
  smartbillMode: null,
  smartbillUnitName: null,
  smartbillRatio: null,
  stockStatus: null,
};

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
  saleStepLabel: null,
  leadTimeDays: null,
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
      sale: DEFAULT_SALE,
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
      sale: DEFAULT_SALE,
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

describe("coloanele de vânzare (9b)", () => {
  const header = exportHeaders();
  const cell = (row: string[] | undefined, label: string): string | undefined =>
    row?.[header.indexOf(label)];
  const liner: ExportProductData = {
    ...product,
    saleStepLabel: "rolă",
    leadTimeDays: 7,
    variants: [
      {
        ...(product.variants[0] as ExportProductData["variants"][number]),
        sale: {
          unitSymbol: "mp",
          priceBasis: "unit",
          saleStep: 412_500,
          minSteps: 2,
          smartbillMode: "ratio",
          smartbillUnitName: "rola",
          smartbillRatio: 412_500,
          stockStatus: null,
        },
      },
    ],
  };

  it("valorile EFECTIVE ale variantei, cu virgulă zecimală; etichete în română", () => {
    const [row] = productRows(liner, stamp).map((r) => r.map(cellToCsvText));
    expect(cell(row, "Unitate de măsură")).toBe("mp");
    expect(cell(row, "Baza prețului")).toBe("Pe unitate");
    expect(cell(row, "Pas de vânzare")).toBe("41,25");
    expect(cell(row, "Minim (pași)")).toBe("2");
    expect(cell(row, "Denumire pas")).toBe("rolă");
    expect(cell(row, "Mod conversie SmartBill")).toBe("Raport");
    expect(cell(row, "Unitate SmartBill")).toBe("rola");
    expect(cell(row, "Raport SmartBill")).toBe("41,25");
    expect(cell(row, "Stare stoc")).toBe("");
    expect(cell(row, "Termen livrare (zile)")).toBe("7");
  });

  it("produs la bucată: «buc», pe unitate, pas 1; restul gol (nimic inventat)", () => {
    const [row] = productRows(product, stamp).map((r) => r.map(cellToCsvText));
    expect(cell(row, "Unitate de măsură")).toBe("buc");
    expect(cell(row, "Baza prețului")).toBe("Pe unitate");
    expect(cell(row, "Pas de vânzare")).toBe("1");
    for (const label of [
      "Minim (pași)",
      "Denumire pas",
      "Mod conversie SmartBill",
      "Unitate SmartBill",
      "Raport SmartBill",
      "Stare stoc",
      "Termen livrare (zile)",
    ]) {
      expect(cell(row, label), label).toBe("");
    }
  });

  it("baza «pe pas» și toate modurile SmartBill au etichete; starea apare doar la negestionate", () => {
    const base = product.variants[0] as ExportProductData["variants"][number];
    const make = (sale: Partial<ExportVariantSale>): ExportProductData => ({
      ...product,
      variants: [{ ...base, sale: { ...DEFAULT_SALE, ...sale } }],
    });
    const read = (p: ExportProductData, label: string) =>
      cell(productRows(p, stamp).map((r) => r.map(cellToCsvText))[0], label);
    expect(read(make({ priceBasis: "step" }), "Baza prețului")).toBe("Pe pas");
    expect(read(make({ smartbillMode: "same_unit" }), "Mod conversie SmartBill")).toBe(
      "Aceeași unitate",
    );
    expect(read(make({ smartbillMode: "steps" }), "Mod conversie SmartBill")).toBe("Pași");
    for (const [status, label] of [
      ["instock", "În stoc"],
      ["outofstock", "Stoc epuizat"],
      ["onbackorder", "La comandă"],
    ] as const) {
      expect(read(make({ stockStatus: status }), "Stare stoc")).toBe(label);
    }
    expect(read(make({ stockStatus: null }), "Stare stoc")).toBe("");
  });

  it("pasul fracționar nu pierde zecimale și nu trece prin float (0,0001 și 214748)", () => {
    const base = product.variants[0] as ExportProductData["variants"][number];
    const stepOf = (ticks: number) =>
      cell(
        productRows(
          { ...product, variants: [{ ...base, sale: { ...DEFAULT_SALE, saleStep: ticks } }] },
          stamp,
        ).map((r) => r.map(cellToCsvText))[0],
        "Pas de vânzare",
      );
    expect(stepOf(1)).toBe("0,0001");
    expect(stepOf(25_000)).toBe("2,5");
    expect(stepOf(2_147_480_000)).toBe("214748");
  });
});

describe("eticheta unității la export: simbolul când e unic, codul când simbolul e ambiguu (altfel fișierul nu se reimportă)", () => {
  const units = [
    { id: "u1", code: "mp", symbol: "mp" },
    { id: "u2", code: "kg", symbol: "kg" },
    { id: "u3", code: "e2e-mp", symbol: "MP" },
    { id: "u4", code: "set1", symbol: "set" },
    { id: "u5", code: "set2", symbol: "Set" },
    { id: "u6", code: "rola", symbol: "rolă" },
    { id: "u7", code: "rola-2", symbol: "rola" },
  ];

  it("simbolul unic rămâne simbol; cele care se ciocnesc (fără diferență de majuscule sau diacritice) devin cod", () => {
    const labels = unitLabels(units);
    expect(labels.get("u2")).toBe("kg");
    expect(labels.get("u1")).toBe("mp");
    // «mp» și «MP» sunt aceeași scriere pentru import: ambele devin cod
    expect(labels.get("u1")).toBe("mp");
    expect(labels.get("u3")).toBe("e2e-mp");
    expect(labels.get("u4")).toBe("set1");
    expect(labels.get("u5")).toBe("set2");
    // «rolă» și «rola» se potrivesc la fel după normalizare
    expect(labels.get("u6")).toBe("rola");
    expect(labels.get("u7")).toBe("rola-2");
  });

  it("fără unități sau cu una singură: simbolul ei", () => {
    expect(unitLabels([]).size).toBe(0);
    expect(unitLabels([{ id: "x", code: "c", symbol: "ml" }]).get("x")).toBe("ml");
  });
});
