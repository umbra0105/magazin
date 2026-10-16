import { describe, expect, it } from "vitest";
import {
  IMPORT_FIELDS,
  isCostLikeFieldKey,
  isCostLikeHeader,
  isImageHeader,
  suggestMapping,
  type ImportFieldKey,
} from "./import-fields";
import type { ParsedTable } from "./import-file";
import {
  ImportMappingError,
  buildBrandIndex,
  buildCategoryIndex,
  collectLookups,
  parseLeiToBani,
  planImport,
  type ExistingVariant,
  type ImportMapping,
  type ImportSnapshot,
} from "./import-plan";
import { instructionRows, templateRows } from "./import-template";

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

const mapping = (...columns: (ImportFieldKey | null)[]): ImportMapping => ({ columns });

function existing(over: Partial<ExistingVariant> & { sku: string }): ExistingVariant {
  return {
    variantId: `v-${over.sku}`,
    productId: `p-${over.sku}`,
    ean: null,
    price: 10_000,
    salePrice: null,
    warrantyMonths: null,
    weightGrams: null,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    ...over,
    product: {
      title: `Produs ${over.sku}`,
      slug: `produs-${over.sku.toLowerCase()}`,
      subtitle: null,
      description: null,
      status: "draft",
      deleted: false,
      brandId: null,
      shippingClass: "standard",
      categoryIds: [],
      ...over.product,
    },
  };
}

const categories = [
  { id: "c-pompe", name: "Pompe", parentId: null },
  { id: "c-circ", name: "Pompe de circulație", parentId: "c-pompe" },
  { id: "c-filtre", name: "Filtrare", parentId: null },
  { id: "c-nisip", name: "Filtre cu nisip", parentId: "c-filtre" },
];

function snapshot(
  variants: ExistingVariant[] = [],
  extra: Partial<ImportSnapshot> = {},
): ImportSnapshot {
  return {
    variantsBySku: new Map(variants.map((v) => [v.sku.toLowerCase(), v])),
    slugOwners: new Map(),
    categoryIndex: buildCategoryIndex(categories),
    brandIndex: buildBrandIndex([
      { id: "b-hayward", name: "Hayward" },
      { id: "b-x1", name: "Dublu" },
      { id: "b-x2", name: "dublu" },
    ]),
    ...extra,
  };
}

const messagesOf = (plan: ReturnType<typeof planImport>, i: number): string[] =>
  (plan.rows[i]?.messages ?? []).map((m) => m.text);

describe("definiția câmpurilor, maparea automată și șablonul", () => {
  it("antetul fiecărui câmp din șablon se mapează automat pe el însuși (șablonul nu se desincronizează)", () => {
    const labels = IMPORT_FIELDS.map((f) => f.label);
    expect(suggestMapping(labels).map((c) => c.field)).toEqual(IMPORT_FIELDS.map((f) => f.key));
    expect(templateRows()[0]).toEqual(labels);
    expect(templateRows()).toHaveLength(3);
    expect(templateRows().every((row) => row.length === IMPORT_FIELDS.length)).toBe(true);
    // fiecare câmp apare în instrucțiuni
    const described = instructionRows().map((r) => r[0]);
    for (const label of labels) expect(described).toContain(label);
  });

  it("exemplele din șablon trec prin import fără nicio eroare", () => {
    const [header, a, b] = templateRows() as [string[], string[], string[]];
    const plan = planImport(
      table(header, [a, b]),
      mapping(...IMPORT_FIELDS.map((f) => f.key)),
      snapshot([], {
        categoryIndex: buildCategoryIndex([
          ...categories,
          { id: "c-acc", name: "Accesorii", parentId: null },
        ]),
        brandIndex: buildBrandIndex([{ id: "b-hayward", name: "Hayward" }]),
      }),
    );
    expect(plan.rows.map((r) => [r.outcome, messagesOf(plan, plan.rows.indexOf(r))])).toEqual([
      ["new", []],
      ["new", []],
    ]);
  });

  it("recunoaște antete în română și engleză, o singură dată pe câmp, și blochează cost/imagini", () => {
    const suggested = suggestMapping([
      "Cod produs",
      "Nume",
      "Preț cu TVA",
      "Regular price",
      "Preț achiziție",
      "Imagini",
      "Cost",
      "Altceva",
      "Furnizor",
    ]);
    expect(suggested.map((c) => c.field)).toEqual([
      "sku",
      "title",
      "price",
      null, // „Regular price” e tot prețul: câmpul e deja luat
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(suggested.map((c) => c.blocked)).toEqual([
      null,
      null,
      null,
      null,
      "cost",
      "images",
      "cost",
      null,
      "cost",
    ]);
  });

  it("antete de cost și de imagini, în orice scriere", () => {
    for (const header of [
      "costPrice",
      "Cost net",
      "Preț de achiziție",
      "NIR",
      "Preț furnizor",
      "purchase price",
    ]) {
      expect(isCostLikeHeader(header), header).toBe(true);
    }
    for (const header of ["Preț", "Titlu", "SKU", "Greutate (g)"]) {
      expect(isCostLikeHeader(header), header).toBe(false);
    }
    expect(isCostLikeFieldKey("costPrice")).toBe(true);
    expect(isCostLikeFieldKey("price")).toBe(false);
    for (const header of ["Imagini", "images", "Poze produs", "Foto"]) {
      expect(isImageHeader(header), header).toBe(true);
    }
    expect(isImageHeader("Descriere")).toBe(false);
  });
});

describe("parseLeiToBani", () => {
  it("convertește exact, cu virgulă sau punct, fără float", () => {
    const value = (raw: string) => {
      const r = parseLeiToBani(raw);
      return r.ok ? r.value : r.error;
    };
    expect(value("199")).toBe(19_900);
    expect(value("199,5")).toBe(19_950);
    expect(value("199.90")).toBe(19_990);
    expect(value("  1 299,00 lei")).toBe(129_900);
    expect(value("0,01")).toBe(1);
    expect(value("19.99")).toBe(1999);
    expect(value("10000000")).toBe(1_000_000_000);
  });

  it("refuză, fără rotunjire: 3 zecimale, separator de mii, litere, zero, negativ, peste plafon", () => {
    for (const raw of [
      "19,999",
      "1.299,00",
      "1,299.00",
      "abc",
      "0",
      "0,00",
      "-5",
      "10000000,01",
      "1e3",
      "",
    ]) {
      expect(parseLeiToBani(raw).ok, raw).toBe(false);
    }
  });
});

describe("planImport: produse noi", () => {
  const m = mapping("sku", "title", "price", "salePrice", "categories", "brand", "ean", "status");
  const headers = ["SKU", "Titlu", "Preț", "Promo", "Categorii", "Brand", "EAN", "Stare"];

  it("creează produse simple, ciornă implicit, cu valorile normalizate", () => {
    const plan = planImport(
      table(headers, [
        [
          "N1",
          "Pompă nouă",
          "1299,50",
          "999",
          "Pompe > Pompe de circulație | Filtrare",
          "hayward",
          "5901234123457",
          "",
        ],
        ["N2", "Alta", "10", "", "", "", "", "Activ"],
      ]),
      m,
      snapshot(),
    );
    expect(plan.counts).toMatchObject({ new: 2, errors: 0 });
    const first = plan.rows[0]?.op;
    expect(first).toMatchObject({
      kind: "create",
      input: {
        title: "Pompă nouă",
        status: "draft",
        brandId: "b-hayward",
        categoryIds: ["c-circ", "c-filtre"],
        variants: [
          { sku: "N1", price: 129_950, salePrice: 99_900, ean: "5901234123457", isDefault: true },
        ],
      },
    });
    expect(plan.rows[1]?.op).toMatchObject({ input: { status: "active" } });
    expect(plan.rows[0]?.changed).toContain("Preț (lei, cu TVA)");
  });

  it("un produs nou fără titlu sau fără preț e eroare cu motiv; restul rândurilor merg mai departe", () => {
    const plan = planImport(
      table(headers, [
        ["N1", "", "10", "", "", "", "", ""],
        ["N2", "Fără preț", "", "", "", "", "", ""],
        ["N3", "Bun", "5", "", "", "", "", ""],
      ]),
      m,
      snapshot(),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "error", "new"]);
    expect(messagesOf(plan, 0)[0]).toMatch(/Titlu: obligatoriu la un produs nou/);
    expect(messagesOf(plan, 1)[0]).toMatch(/Preț: obligatoriu la un produs nou/);
    expect(plan.counts).toMatchObject({ new: 1, errors: 2 });
  });

  it("categorie sau brand inexistent, EAN greșit, promoție peste preț: erori pe rând, fără creare", () => {
    const plan = planImport(
      table(headers, [
        ["N1", "A", "10", "", "Piscine > Inexistent", "", "", ""],
        ["N2", "B", "10", "", "", "Necunoscut", "", ""],
        ["N3", "C", "10", "", "", "dublu", "", ""],
        ["N4", "D", "10", "", "", "", "123", ""],
        ["N5", "E", "10", "20", "", "", "", ""],
        ["N6", "F", "10", "", "Pompe >", "", "", ""],
      ]),
      m,
      snapshot(),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(Array(6).fill("error"));
    expect(messagesOf(plan, 0)[0]).toMatch(/Categorii: categoria „Piscine > Inexistent” nu există/);
    expect(messagesOf(plan, 1)[0]).toMatch(/Brand: brandul „Necunoscut” nu există/);
    expect(messagesOf(plan, 2)[0]).toMatch(/mai multe branduri/);
    expect(messagesOf(plan, 3)[0]).toMatch(/EAN/);
    expect(messagesOf(plan, 4)[0]).toMatch(/Prețul redus nu poate depăși/);
    expect(messagesOf(plan, 5)[0]).toMatch(/nivel gol/);
  });

  it("SKU repetat în fișier: al doilea rând e eroare cu trimitere la primul", () => {
    const plan = planImport(
      table(headers, [
        ["N1", "A", "10", "", "", "", "", ""],
        ["n1", "B", "10", "", "", "", "", ""],
      ]),
      m,
      snapshot(),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["new", "error"]);
    expect(messagesOf(plan, 1)[0]).toBe("SKU repetat: apare și la rândul 2 din fișier");
  });

  it("adresa dată explicit: refuzată dacă e luată (în catalog sau în fișier)", () => {
    const sm = mapping("sku", "title", "price", "slug");
    const plan = planImport(
      table(
        ["SKU", "Titlu", "Preț", "Slug"],
        [
          ["N1", "A", "10", "luat"],
          ["N2", "B", "10", "liber"],
          ["N3", "C", "10", "liber"],
          ["N4", "D", "10", "Nu Valid"],
        ],
      ),
      sm,
      snapshot([], { slugOwners: new Map([["luat", "p-altul"]]) }),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "new", "error", "error"]);
    expect(messagesOf(plan, 2)[0]).toMatch(/folosită și la rândul 3/);
  });

  it("marcajul de ștergere nu merge la titlu sau preț", () => {
    const plan = planImport(table(headers, [["N1", "-", "-", "", "", "", "", ""]]), m, snapshot());
    expect(plan.rows[0]?.outcome).toBe("error");
    expect(messagesOf(plan, 0).join("|")).toMatch(/Titlu: valoarea nu se poate șterge/);
    expect(messagesOf(plan, 0).join("|")).toContain(
      "Preț (lei, cu TVA): valoarea nu se poate șterge",
    );
  });
});

describe("planImport: produse existente", () => {
  const m = mapping("sku", "title", "price", "salePrice", "brand", "ean", "categories");
  const headers = ["SKU", "Titlu", "Preț", "Promo", "Brand", "EAN", "Categorii"];

  it("actualizează doar ce s-a schimbat; celula goală lasă neschimbat; rândul identic e «neschimbat»", () => {
    const current = existing({
      sku: "A1",
      price: 10_000,
      ean: "5901234123457",
      product: {
        title: "Vechi",
        slug: "vechi",
        subtitle: null,
        description: null,
        status: "active",
        deleted: false,
        brandId: "b-hayward",
        shippingClass: "standard",
        categoryIds: ["c-circ"],
      },
    });
    const plan = planImport(
      table(headers, [
        ["A1", "Nou", "120,50", "", "", "", ""],
        ["A1-bis", "x", "1", "", "", "", ""],
      ]),
      m,
      snapshot([current]),
    );
    expect(plan.rows[0]).toMatchObject({
      outcome: "updated",
      changed: ["Titlu", "Preț (lei, cu TVA)"],
      op: {
        kind: "update",
        productId: "p-A1",
        variantId: "v-A1",
        productPatch: { title: "Nou" },
        variantPatch: { price: 12_050 },
        categoryIds: null,
      },
    });

    const same = planImport(
      table(headers, [
        ["a1", "Vechi", "100", "", "hayward", "5901234123457", "Pompe > Pompe de circulație"],
      ]),
      m,
      snapshot([current]),
    );
    expect(same.rows[0]?.outcome).toBe("unchanged");
    expect(same.counts.unchanged).toBe(1);
  });

  it("marcajul «-» șterge brandul, EAN-ul și promoția; categoriile se înlocuiesc", () => {
    const current = existing({
      sku: "A1",
      price: 10_000,
      salePrice: 8_000,
      ean: "5901234123457",
      product: {
        title: "T",
        slug: "t",
        subtitle: null,
        description: null,
        status: "draft",
        deleted: false,
        brandId: "b-hayward",
        shippingClass: "standard",
        categoryIds: ["c-circ"],
      },
    });
    const plan = planImport(
      table(headers, [["A1", "", "", "-", "-", "-", "Filtrare > Filtre cu nisip"]]),
      m,
      snapshot([current]),
    );
    expect(plan.rows[0]?.op).toMatchObject({
      kind: "update",
      productPatch: { brandId: null },
      variantPatch: { salePrice: null, ean: null },
      categoryIds: ["c-nisip"],
    });
  });

  it("promoția din fișier față de prețul curent; prețul nou sub promoția curentă e eroare", () => {
    const current = existing({ sku: "A1", price: 10_000, salePrice: 8_000 });
    const plan = planImport(
      table(headers, [
        ["A1", "", "70", "", "", "", ""],
        ["A2", "", "", "150", "", "", ""],
      ]),
      m,
      snapshot([current, existing({ sku: "A2", price: 10_000 })]),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "error"]);
    expect(messagesOf(plan, 0)[0]).toMatch(/Preț promoțional: nu poate depăși/);
  });

  it("produsele arhivate sau din coșul de gunoi sunt ignorate, nu actualizate în tăcere", () => {
    const archived = existing({
      sku: "AR",
      product: {
        title: "t",
        slug: "t",
        subtitle: null,
        description: null,
        status: "archived",
        deleted: false,
        brandId: null,
        shippingClass: "standard",
        categoryIds: [],
      },
    });
    const trashed = existing({
      sku: "TR",
      product: {
        title: "t",
        slug: "t2",
        subtitle: null,
        description: null,
        status: "active",
        deleted: true,
        brandId: null,
        shippingClass: "standard",
        categoryIds: [],
      },
    });
    const plan = planImport(
      table(headers, [
        ["AR", "Nou", "10", "", "", "", ""],
        ["TR", "Nou", "10", "", "", "", ""],
      ]),
      m,
      snapshot([archived, trashed]),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(messagesOf(plan, 0)[0]).toMatch(/produs arhivat/);
    expect(messagesOf(plan, 1)[0]).toMatch(/coșul de gunoi/);
    expect(plan.counts).toMatchObject({ skipped: 2, warnings: 2, errors: 0 });
    expect(plan.rows.every((r) => r.op === null)).toBe(true);
  });

  it("două rânduri pentru variante ale aceluiași produs nu pot seta valori diferite pe produs", () => {
    const a = existing({ sku: "V1", productId: "p-shared" });
    const b = existing({ sku: "V2", productId: "p-shared" });
    const plan = planImport(
      table(headers, [
        ["V1", "Titlu A", "", "", "", "", ""],
        ["V2", "Titlu B", "", "", "", "", ""],
      ]),
      m,
      snapshot([a, b]),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["updated", "error"]);
    expect(messagesOf(plan, 1)[0]).toMatch(/Același produs e modificat și la rândul 2/);
  });

  it("noua adresă a unui produs existent: refuzată dacă e a altuia", () => {
    const sm = mapping("sku", "slug");
    const plan = planImport(
      table(
        ["SKU", "Slug"],
        [
          ["A1", "luat"],
          ["A2", "liber"],
        ],
      ),
      sm,
      snapshot([existing({ sku: "A1" }), existing({ sku: "A2" })], {
        slugOwners: new Map([["luat", "p-altul"]]),
      }),
    );
    expect(plan.rows.map((r) => r.outcome)).toEqual(["error", "updated"]);
  });
});

describe("planImport: maparea, avertismentele și amprenta", () => {
  it("refuză maparea fără SKU, cu câmp dublat sau cu o coloană de cost mapată pe orice câmp", () => {
    const t = table(["SKU", "Preț achiziție", "Preț"], [["A1", "5", "10"]]);
    expect(() => planImport(t, mapping("sku", "price", null), snapshot())).toThrowError(
      ImportMappingError,
    );
    try {
      planImport(t, mapping("sku", "price", null), snapshot());
    } catch (error) {
      expect((error as ImportMappingError).code).toBe("IMPORT_MAPPING_COST");
      expect((error as ImportMappingError).message).toMatch(/prețul de achiziție nu se importă/i);
    }
    expect(() => planImport(t, mapping(null, null, "price"), snapshot())).toThrowError(/SKU/);
    expect(() => planImport(t, mapping("sku", null, "sku"), snapshot())).toThrowError(
      /mapat pe mai multe/,
    );
    expect(() => planImport(t, mapping("sku", null, null), snapshot())).toThrowError(
      /cel puțin o coloană/,
    );
    expect(() => planImport(t, mapping("sku"), snapshot())).toThrowError(/nu corespunde/);
  });

  it("coloana de imagini mapată e refuzată; nemapată dă avertisment la nivel de fișier", () => {
    const t = table(
      ["SKU", "Preț", "Imagini", "Preț achiziție"],
      [["A1", "10", "http://x/a.jpg", "3"]],
    );
    expect(() => planImport(t, mapping("sku", "price", "title", null), snapshot())).toThrowError(
      /conține imagini/,
    );
    const plan = planImport(t, mapping("sku", "price", null, null), snapshot());
    expect(plan.fileWarnings.join("|")).toMatch(/Imagini.*ignorată/);
    expect(plan.fileWarnings.join("|")).toMatch(/Preț achiziție.*nu se importă/);
  });

  it("raportul nu conține valorile din coloanele de cost (nici dacă fișierul le are)", () => {
    const t = table(["SKU", "Preț", "Preț achiziție"], [["A1", "10", "987654321"]]);
    const plan = planImport(t, mapping("sku", "price", null), snapshot());
    expect(JSON.stringify(plan)).not.toContain("987654321");
  });

  it("amprenta e stabilă pentru aceleași date și se schimbă când se schimbă fișierul, maparea sau catalogul", () => {
    const headers = ["SKU", "Titlu", "Preț"];
    const rows = [["N1", "A", "10"]];
    const base = planImport(table(headers, rows), mapping("sku", "title", "price"), snapshot());
    const again = planImport(table(headers, rows), mapping("sku", "title", "price"), snapshot());
    expect(again.fingerprint).toBe(base.fingerprint);
    expect(base.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const otherFile = planImport(
      table(headers, [["N1", "A", "11"]]),
      mapping("sku", "title", "price"),
      snapshot(),
    );
    expect(otherFile.fingerprint).not.toBe(base.fingerprint);
    const otherCatalog = planImport(
      table(headers, rows),
      mapping("sku", "title", "price"),
      snapshot([existing({ sku: "N1" })]),
    );
    expect(otherCatalog.fingerprint).not.toBe(base.fingerprint);
  });

  it("collectLookups cere din catalog doar SKU-urile și adresele din fișier", () => {
    const t = table(
      ["SKU", "Slug", "Titlu"],
      [
        ["A1", "x", "t"],
        ["A2", "-", "t"],
        ["", "y", "t"],
      ],
    );
    expect(collectLookups(t, mapping("sku", "slug", "title"))).toEqual({
      skus: ["A1", "A2"],
      slugs: ["x", "y"],
    });
  });
});
