import { describe, expect, it } from "vitest";
import { templateRows } from "./import-template";
import { IMPORT_FIELDS, type ImportFieldKey } from "./import-fields";
import type { ParsedTable } from "./import-file";
import {
  buildBrandIndex,
  buildCategoryIndex,
  planImport,
  type ExistingVariant,
  type ImportSnapshot,
} from "./import-plan";
import { emptyExistingSale, type ExistingSale, type ImportUnit } from "./import-sale";

/**
 * Faza 5, punctul 9b: coloanele de vânzare la import (unitate, bază, pas, minim, denumire, conversie SmartBill, stare stoc,
 * termen). Regula: aceeași valoare la TOATE rândurile unui produs (și fișierul conține toate variantele lui) → pe produs;
 * valori diferite sau fișier parțial → pe variantă. «Stare stoc» doar la variantele negestionate. Produsele noi se creează cu
 * `manageStock = false` explicit (inventarul îl face utilizatorul).
 */

const UNITS: ImportUnit[] = [
  { id: "u-buc", code: "buc", name: "Bucată", symbol: "buc", decimals: 0, isActive: true },
  { id: "u-mp", code: "mp", name: "Metru pătrat", symbol: "mp", decimals: 2, isActive: true },
  { id: "u-ml", code: "ml", name: "Metru liniar", symbol: "ml", decimals: 1, isActive: true },
  { id: "u-kg", code: "kg", name: "Kilogram", symbol: "kg", decimals: 3, isActive: true },
];

function table(headers: string[], rows: string[][]): ParsedTable {
  return {
    format: "csv",
    delimiter: ";",
    delimiterSource: "detected",
    encoding: "utf-8",
    headers,
    rows,
    rowNumbers: rows.map((_, i) => i + 2),
    warnings: [],
  };
}

type SaleOverride = {
  variant?: Partial<ExistingSale["variant"]>;
  product?: Partial<ExistingSale["product"]>;
};

/** O variantă existentă, cu configurarea de vânzare dată (restul implicit); `siblings` = toate variantele produsului. */
function variant(
  sku: string,
  over: SaleOverride = {},
  productId = `p-${sku}`,
  siblings: string[] = [`v-${sku}`],
): ExistingVariant {
  const base = emptyExistingSale(siblings);
  return {
    variantId: `v-${sku}`,
    productId,
    sku,
    ean: null,
    price: 10_000,
    salePrice: null,
    warrantyMonths: null,
    weightGrams: null,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    sale: {
      variant: { ...base.variant, ...over.variant },
      product: { ...base.product, ...over.product },
    },
    product: {
      title: `Produs ${productId}`,
      slug: `produs-${productId}`,
      subtitle: null,
      description: null,
      status: "draft",
      deleted: false,
      brandId: null,
      shippingClass: "standard",
      categoryIds: [],
    },
  };
}

function snapshot(variants: ExistingVariant[] = []): ImportSnapshot {
  return {
    variantsBySku: new Map(variants.map((v) => [v.sku.toLowerCase(), v])),
    slugOwners: new Map(),
    categoryIndex: buildCategoryIndex([
      { id: "c-pompe", name: "Pompe", parentId: null },
      { id: "c-circ", name: "Pompe de circulație", parentId: "c-pompe" },
      { id: "c-acc", name: "Accesorii", parentId: null },
      { id: "c-filtre", name: "Filtrare", parentId: null },
      { id: "c-nisip", name: "Filtre cu nisip", parentId: "c-filtre" },
    ]),
    brandIndex: buildBrandIndex([]),
    units: UNITS,
  };
}

const LABEL: Partial<Record<ImportFieldKey, string>> = Object.fromEntries(
  IMPORT_FIELDS.map((f) => [f.key, f.label]),
);

/** Planul pentru un fișier cu coloanele date (SKU primul); fiecare rând e o listă de celule în aceeași ordine. */
function run(fields: ImportFieldKey[], rows: string[][], variants: ExistingVariant[] = []) {
  const keys = ["sku", ...fields] as ImportFieldKey[];
  return planImport(
    table(
      keys.map((k) => LABEL[k] as string),
      rows,
    ),
    { columns: keys },
    snapshot(variants),
  );
}

const messages = (plan: ReturnType<typeof run>, i: number) =>
  (plan.rows[i]?.messages ?? []).map((m) => `${m.level}: ${m.text}`);

function updateOf(plan: ReturnType<typeof run>, i: number) {
  const op = plan.rows[i]?.op;
  if (!op || op.kind !== "update")
    throw new Error(`rândul ${i} nu e o actualizare: ${plan.rows[i]?.outcome}`);
  return op;
}

describe("produse noi", () => {
  it("toate coloanele: pe produs unitatea, baza, pasul, minimul, denumirea, starea, termenul; conversia SmartBill pe variantă; manageStock explicit false", () => {
    const plan = run(
      [
        "title",
        "price",
        "unit",
        "priceBasis",
        "saleStep",
        "minSteps",
        "saleStepLabel",
        "smartbillMode",
        "smartbillUnitName",
        "smartbillRatio",
        "stockStatus",
        "leadTimeDays",
      ],
      [
        [
          "N-1",
          "Liner",
          "87,35",
          "mp",
          "Pe unitate",
          "41,25",
          "2",
          "rolă",
          "Raport",
          "rola",
          "41,25",
          "La comandă",
          "7",
        ],
      ],
    );
    expect(plan.rows[0]?.outcome, messages(plan, 0).join("; ")).toBe("new");
    const op = plan.rows[0]?.op;
    if (op?.kind !== "create") throw new Error("așteptam create");
    expect(op.input).toMatchObject({
      measureUnitId: "u-mp",
      priceBasis: "unit",
      saleStep: 412_500,
      minSteps: 2,
      saleStepLabel: "rolă",
      stockStatus: "onbackorder",
      leadTimeDays: 7,
      manageStock: false,
    });
    const variantInput = (op.input["variants"] as Record<string, unknown>[])[0];
    expect(variantInput).toMatchObject({
      smartbillMode: "ratio",
      smartbillUnitName: "rola",
      smartbillRatio: 412_500,
    });
    // pe variantă nu se pun unitatea, baza, pasul (se moștenesc de la produs)
    expect(variantInput).not.toHaveProperty("measureUnitId");
    expect(variantInput).not.toHaveProperty("saleStep");
  });

  it("fără coloane de vânzare: tot se creează negestionat (regula importului), fără alte câmpuri de vânzare", () => {
    const plan = run(["title", "price"], [["N-2", "Simplu", "10,00"]]);
    const op = plan.rows[0]?.op;
    if (op?.kind !== "create") throw new Error("așteptam create");
    expect(op.input["manageStock"]).toBe(false);
    for (const key of [
      "measureUnitId",
      "priceBasis",
      "saleStep",
      "minSteps",
      "saleStepLabel",
      "leadTimeDays",
      "stockStatus",
    ]) {
      expect(op.input, key).not.toHaveProperty(key);
    }
  });

  it("«buc» înseamnă la bucată: fără unitate pe produs; stare stoc implicită cu manageStock false", () => {
    const plan = run(["title", "price", "unit"], [["N-3", "Bucată", "5,00", "buc"]]);
    const op = plan.rows[0]?.op;
    if (op?.kind !== "create") throw new Error("așteptam create");
    expect(op.input["measureUnitId"]).toBeNull();
  });

  it("pasul față de zecimalele unității, raportul inexact și starea necunoscută: erori pe rând, nimic creat", () => {
    const plan = run(
      ["title", "price", "unit", "saleStep", "smartbillMode", "smartbillRatio"],
      [
        ["E-1", "A", "1,00", "mp", "2,033", "", ""],
        ["E-2", "B", "1,00", "mp", "2,03", "Raport", "3"],
        ["E-3", "C", "1,00", "mp", "2,03", "Raport", ""],
        ["E-4", "D", "1,00", "mp", "2,03", "", "5"],
      ],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "error", "error", "error"]);
    expect(messages(plan, 0).join(" ")).toContain("Pas de vânzare");
    expect(messages(plan, 1).join(" ")).toContain("Raport SmartBill");
    expect(messages(plan, 2).join(" ")).toContain("Raport SmartBill");
    expect(messages(plan, 3).join(" ")).toContain("Raport SmartBill");
  });

  it("unitate necunoscută sau dezactivată și termen peste 365: eroare cu câmpul numit", () => {
    const plan = run(
      ["title", "price", "unit", "leadTimeDays"],
      [
        ["E-5", "A", "1,00", "litri", ""],
        ["E-6", "B", "1,00", "", "400"],
      ],
    );
    expect(messages(plan, 0).join(" ")).toContain("Unitate de măsură");
    expect(messages(plan, 1).join(" ")).toContain("Termen livrare");
  });
});

describe("produse existente: pe produs sau pe variantă", () => {
  const two = ["v-A-1", "v-A-2"];
  const MP = { measureUnitId: "u-mp" };
  const a1 = (over: SaleOverride = {}) =>
    variant("A-1", { ...over, product: { ...MP, ...over.product } }, "p-A", two);
  const a2 = (over: SaleOverride = {}) =>
    variant("A-2", { ...over, product: { ...MP, ...over.product } }, "p-A", two);

  it("o singură variantă: valoarea merge pe produs (fișierul le conține pe toate)", () => {
    const plan = run(
      ["saleStep"],
      [["S-1", "2,03"]],
      [variant("S-1", { product: { measureUnitId: "u-mp" } })],
    );
    expect(plan.rows[0]?.outcome).toBe("updated");
    expect(updateOf(plan, 0)).toMatchObject({
      productPatch: { saleStep: 20_300 },
      variantPatch: null,
    });
    expect(plan.rows[0]?.changed).toEqual(["Pas de vânzare"]);
  });

  it("aceeași valoare la toate variantele din fișier → pe produs; suprascrierile variantelor se golesc", () => {
    const plan = run(
      ["saleStep"],
      [
        ["A-1", "2,5"],
        ["A-2", "2,5"],
      ],
      [a1({ variant: { saleStep: 15_000 } }), a2()],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["updated", "updated"]);
    expect(updateOf(plan, 0)).toMatchObject({
      productPatch: { saleStep: 25_000 },
      variantPatch: { saleStep: null },
    });
    expect(updateOf(plan, 1)).toMatchObject({
      productPatch: { saleStep: 25_000 },
      variantPatch: null,
    });
  });

  it("valori diferite (abachi: 1,5 și 1,8) → pe fiecare variantă; produsul rămâne neatins", () => {
    const plan = run(
      ["unit", "saleStep"],
      [
        ["A-1", "ml", "1,5"],
        ["A-2", "ml", "1,8"],
      ],
      [a1(), a2()],
    );
    expect(updateOf(plan, 0)).toMatchObject({ variantPatch: { saleStep: 15_000 } });
    expect(updateOf(plan, 1)).toMatchObject({ variantPatch: { saleStep: 18_000 } });
    // unitatea e aceeași pe ambele rânduri → pe produs; pasul diferă → pe variantă
    expect(updateOf(plan, 0).productPatch).toEqual({ measureUnitId: "u-ml" });
    expect(updateOf(plan, 0).productPatch).not.toHaveProperty("saleStep");
  });

  it("fișier parțial (o variantă din două) → pe variantă, ca să nu schimbe pasul variantei care lipsește din fișier", () => {
    const plan = run(["saleStep"], [["A-1", "2,5"]], [a1(), a2()]);
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { saleStep: 25_000 },
      productPatch: null,
    });
  });

  it("un rând fără valoare (celulă goală) → nu e uniform: doar rândul cu valoare se schimbă, pe variantă", () => {
    const plan = run(
      ["saleStep"],
      [
        ["A-1", "2,5"],
        ["A-2", ""],
      ],
      [a1(), a2()],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { saleStep: 25_000 },
      productPatch: null,
    });
    expect(plan.rows[1]?.outcome).toBe("unchanged");
  });

  it("un rând cu eroare în grup: celălalt rând se tratează pe variantă (grupul nu mai e uniform)", () => {
    const plan = run(
      ["saleStep"],
      [
        ["A-1", "2,5"],
        ["A-2", "abc"],
      ],
      [a1(), a2()],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["updated", "error"]);
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { saleStep: 25_000 },
      productPatch: null,
    });
  });

  it("un rând cu valoare validă de pas dar cu eroare pe ALT câmp: grupul nu mai e uniform, iar rândul greșit nu schimbă produsul", () => {
    const plan = run(
      ["saleStep", "minSteps"],
      [
        ["A-1", "2,5", ""],
        ["A-2", "2,5", "abc"],
      ],
      [a1(), a2()],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["updated", "error"]);
    // pasul rândului valid merge pe variantă; nu se scrie pe produs (ar schimba și varianta cu rândul greșit)
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { saleStep: 25_000 },
      productPatch: null,
    });
  });

  it("fișier exportat și reimportat neschimbat: «neschimbat» (se compară valorile EFECTIVE, «buc» ≡ fără unitate, pas gol ≡ o unitate)", () => {
    const plan = run(
      ["unit", "priceBasis", "saleStep", "minSteps"],
      [
        ["A-1", "mp", "Pe unitate", "41,25", "2"],
        ["A-2", "mp", "Pe unitate", "41,25", "2"],
        ["B-1", "buc", "Pe unitate", "1", ""],
      ],
      [
        // produsul A: valorile pe produs; variantele fără suprascrieri
        variant(
          "A-1",
          { product: { measureUnitId: "u-mp", saleStep: 412_500, minSteps: 2 } },
          "p-A",
          two,
        ),
        variant(
          "A-2",
          { product: { measureUnitId: "u-mp", saleStep: 412_500, minSteps: 2 } },
          "p-A",
          two,
        ),
        variant("B-1"),
      ],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(plan.counts).toMatchObject({ unchanged: 3, updated: 0, errors: 0 });
  });

  it("valori efective egale prin suprascriere pe variante: nimic de schimbat, fără scriere de umplutură", () => {
    const plan = run(
      ["saleStep"],
      [
        ["A-1", "2,5"],
        ["A-2", "2,5"],
      ],
      [a1({ variant: { saleStep: 25_000 } }), a2({ variant: { saleStep: 25_000 } })],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
  });

  it("«-» la pas = o unitate: pe produs devine nul; pe variantă (produsul are pas) devine un pas de o unitate explicit", () => {
    const onProduct = run(
      ["saleStep"],
      [["S-1", "-"]],
      [variant("S-1", { product: { saleStep: 25_000 } })],
    );
    expect(updateOf(onProduct, 0)).toMatchObject({ productPatch: { saleStep: null } });
    const onVariant = run(
      ["saleStep"],
      [["A-1", "-"]],
      [a1({ product: { saleStep: 25_000 } }), a2({ product: { saleStep: 25_000 } })],
    );
    expect(updateOf(onVariant, 0)).toMatchObject({
      variantPatch: { saleStep: 10_000 },
      productPatch: null,
    });
  });

  it("unitatea: «buc» pe produs → nul; pe variantă (produsul are unitate) → unitatea «buc» explicită; erori pe rând", () => {
    const onProduct = run(
      ["unit"],
      [["S-1", "buc"]],
      [variant("S-1", { product: { measureUnitId: "u-mp" } })],
    );
    expect(updateOf(onProduct, 0)).toMatchObject({ productPatch: { measureUnitId: null } });
    const onVariant = run(
      ["unit"],
      [["A-1", "buc"]],
      [a1({ product: { measureUnitId: "u-mp" } }), a2({ product: { measureUnitId: "u-mp" } })],
    );
    expect(updateOf(onVariant, 0)).toMatchObject({ variantPatch: { measureUnitId: "u-buc" } });
    const bad = run(["unit"], [["S-1", "litri"]], [variant("S-1")]);
    expect(bad.rows[0]?.outcome).toBe("error");
    expect(messages(bad, 0).join(" ")).toContain("Unitate de măsură");
  });

  it("schimbarea unității cu un pas care nu mai e valid (zecimale) → eroare, nimic planificat", () => {
    const plan = run(
      ["unit"],
      [["S-1", "buc"]],
      [variant("S-1", { product: { measureUnitId: "u-mp", saleStep: 412_500 } })],
    );
    expect(plan.rows[0]?.outcome).toBe("error");
    expect(messages(plan, 0).join(" ")).toContain("Pas de vânzare");
  });

  it("baza prețului: se citește, nu se poate șterge cu «-»", () => {
    const plan = run(
      ["priceBasis"],
      [
        ["S-1", "Pe pas"],
        ["S-2", "-"],
      ],
      [variant("S-1"), variant("S-2")],
    );
    expect(updateOf(plan, 0)).toMatchObject({ productPatch: { priceBasis: "step" } });
    expect(plan.rows[1]?.outcome).toBe("error");
  });

  it("minimul: pe produs când e uniform; «-» = un pas", () => {
    const plan = run(["minSteps"], [["S-1", "3"]], [variant("S-1")]);
    expect(updateOf(plan, 0)).toMatchObject({ productPatch: { minSteps: 3 } });
    const clear = run(["minSteps"], [["S-1", "-"]], [variant("S-1", { product: { minSteps: 3 } })]);
    expect(updateOf(clear, 0)).toMatchObject({ productPatch: { minSteps: null } });
  });
});

describe("denumirea pasului și termenul de livrare (pe produs)", () => {
  it("se scriu pe produs; «-» le șterge; aceeași valoare nu produce modificare", () => {
    const plan = run(
      ["saleStepLabel", "leadTimeDays"],
      [
        ["S-1", "sac", "10"],
        ["S-2", "-", "-"],
        ["S-3", "rolă", "7"],
      ],
      [
        variant("S-1"),
        variant("S-2", { product: { saleStepLabel: "x", leadTimeDays: 3 } }),
        variant("S-3", { product: { saleStepLabel: "rolă", leadTimeDays: 7 } }),
      ],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      productPatch: { saleStepLabel: "sac", leadTimeDays: 10 },
    });
    expect(updateOf(plan, 1)).toMatchObject({
      productPatch: { saleStepLabel: null, leadTimeDays: null },
    });
    expect(plan.rows[2]?.outcome).toBe("unchanged");
  });

  it("variantele aceluiași produs cu valori diferite: eroare (e o valoare a produsului)", () => {
    const plan = run(
      ["leadTimeDays"],
      [
        ["A-1", "5"],
        ["A-2", "9"],
      ],
      [
        variant("A-1", {}, "p-A", ["v-A-1", "v-A-2"]),
        variant("A-2", {}, "p-A", ["v-A-1", "v-A-2"]),
      ],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["updated", "error"]);
    expect(messages(plan, 1).join(" ")).toContain("Același produs");
  });

  it("termen peste 365 sau denumire peste 30 de caractere: eroare pe rând", () => {
    const plan = run(
      ["saleStepLabel", "leadTimeDays"],
      [
        ["S-1", "", "366"],
        ["S-2", "x".repeat(31), ""],
      ],
      [variant("S-1"), variant("S-2")],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "error"]);
  });
});

describe("conversia SmartBill (pe variantă)", () => {
  const withProduct = (over: SaleOverride = {}) =>
    variant("S-1", {
      ...over,
      product: { measureUnitId: "u-mp", saleStep: 412_500, ...over.product },
    });

  it("modul «Raport» cu raport care împarte exact pasul: se scrie perechea mod + raport (și numele unității)", () => {
    const plan = run(
      ["smartbillMode", "smartbillUnitName", "smartbillRatio"],
      [["S-1", "Raport", "rola", "41,25"]],
      [withProduct()],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { smartbillMode: "ratio", smartbillRatio: 412_500, smartbillUnitName: "rola" },
    });
  });

  it("raportul care nu convertește exact pasul, raportul fără modul «Raport» și modul «Raport» fără raport: erori", () => {
    const plan = run(
      ["smartbillMode", "smartbillRatio"],
      [
        ["S-1", "Raport", "0,7"],
        ["S-2", "Aceeași unitate", "5"],
        ["S-3", "Raport", ""],
        ["S-4", "", "5"],
      ],
      [withProduct(), variant("S-2"), variant("S-3"), variant("S-4")],
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "error", "error", "error"]);
    for (const i of [0, 1, 2, 3])
      expect(messages(plan, i).join(" "), String(i)).toContain("Raport SmartBill");
    // mesajele numesc cauza exactă
    expect(messages(plan, 1).join(" ")).toContain("se folosește doar cu modul «Raport»");
    expect(messages(plan, 2).join(" ")).toContain("modul «Raport» cere raportul");
    expect(messages(plan, 3).join(" ")).toContain("se folosește doar cu modul «Raport»");
  });

  it("schimbarea modului la «Aceeași unitate» golește raportul (CHECK: una setată, una nulă)", () => {
    const plan = run(
      ["smartbillMode"],
      [["S-1", "Aceeași unitate"]],
      [withProduct({ variant: { smartbillMode: "ratio", smartbillRatio: 412_500 } })],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { smartbillMode: "same_unit", smartbillRatio: null },
    });
  });

  it("«-» pe mod golește conversia (mod și raport nule)", () => {
    const plan = run(
      ["smartbillMode"],
      [["S-1", "-"]],
      [withProduct({ variant: { smartbillMode: "ratio", smartbillRatio: 412_500 } })],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { smartbillMode: null, smartbillRatio: null },
    });
  });

  it("raport nou cu modul deja «Raport»: se actualizează doar raportul (dacă împarte exact)", () => {
    const plan = run(
      ["smartbillRatio"],
      [["S-1", "82,5"]],
      [withProduct({ variant: { smartbillMode: "ratio", smartbillRatio: 412_500 } })],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { smartbillMode: "ratio", smartbillRatio: 825_000 },
    });
  });

  it("aceleași valori ca acum: neschimbat", () => {
    const plan = run(
      ["smartbillMode", "smartbillUnitName", "smartbillRatio"],
      [["S-1", "Raport", "rola", "41,25"]],
      [
        withProduct({
          variant: { smartbillMode: "ratio", smartbillRatio: 412_500, smartbillUnitName: "rola" },
        }),
      ],
    );
    expect(plan.rows[0]?.outcome).toBe("unchanged");
  });
});

describe("«Stare stoc»: doar la produsele negestionate", () => {
  const unmanaged = (
    sku: string,
    over: SaleOverride = {},
    productId?: string,
    siblings?: string[],
  ) =>
    variant(
      sku,
      { ...over, product: { manageStock: false, stockStatus: "instock", ...over.product } },
      productId,
      siblings,
    );

  it("negestionat: se scrie pe produs (uniform); aceeași valoare: neschimbat", () => {
    const plan = run(
      ["stockStatus"],
      [
        ["U-1", "Stoc epuizat"],
        ["U-2", "În stoc"],
      ],
      [unmanaged("U-1"), unmanaged("U-2")],
    );
    expect(updateOf(plan, 0)).toMatchObject({ productPatch: { stockStatus: "outofstock" } });
    expect(plan.rows[1]?.outcome).toBe("unchanged");
  });

  it("gestionat: ignorat cu avertisment, nu se modifică nimic", () => {
    const plan = run(["stockStatus"], [["M-1", "Stoc epuizat"]], [variant("M-1")]);
    expect(plan.rows[0]?.outcome).toBe("unchanged");
    expect(messages(plan, 0).join(" ")).toMatch(/warning: .*Stare stoc.*gestionat/);
  });

  it("digital: ignorat cu avertisment", () => {
    const plan = run(
      ["stockStatus"],
      [["D-1", "La comandă"]],
      [variant("D-1", { product: { type: "digital", manageStock: false } })],
    );
    expect(plan.rows[0]?.outcome).toBe("unchanged");
    expect(messages(plan, 0).join(" ")).toMatch(/warning: .*digital/);
  });

  it("variantă negestionată într-un produs gestionat: starea se scrie pe variantă, nu pe produs", () => {
    const two = ["v-A-1", "v-A-2"];
    const plan = run(
      ["stockStatus"],
      [
        ["A-1", "La comandă"],
        ["A-2", "La comandă"],
      ],
      [
        variant("A-1", { variant: { manageStock: false } }, "p-A", two),
        variant("A-2", {}, "p-A", two),
      ],
    );
    expect(updateOf(plan, 0)).toMatchObject({
      variantPatch: { stockStatus: "onbackorder" },
      productPatch: null,
    });
    expect(plan.rows[1]?.outcome).toBe("unchanged");
    expect(messages(plan, 1).join(" ")).toContain("warning");
  });

  it("starea necunoscută: eroare cu valorile permise", () => {
    const plan = run(["stockStatus"], [["U-1", "poate"]], [unmanaged("U-1")]);
    expect(plan.rows[0]?.outcome).toBe("error");
    expect(messages(plan, 0).join(" ")).toContain("În stoc, Stoc epuizat sau La comandă");
  });
});

describe("șablonul și amprenta", () => {
  it("exemplele din șablon (cu coloanele noi) trec prin import ca produse noi, fără erori", () => {
    const [header, a, b] = templateRows() as [string[], string[], string[]];
    const plan = planImport(
      table(header, [a, b]),
      { columns: IMPORT_FIELDS.map((f) => f.key) },
      {
        ...snapshot(),

        brandIndex: buildBrandIndex([{ id: "b-hayward", name: "Hayward" }]),
      },
    );
    expect(plan.rows.map((r) => [r.outcome, messages(plan, plan.rows.indexOf(r))])).toEqual([
      ["new", []],
      ["new", []],
    ]);
  });

  it("amprenta se schimbă când se schimbă o valoare de vânzare", () => {
    const mp = variant("S-1", { product: { measureUnitId: "u-mp" } });
    const one = run(["saleStep"], [["S-1", "2,5"]], [mp]);
    const two = run(["saleStep"], [["S-1", "2,6"]], [mp]);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });
});
