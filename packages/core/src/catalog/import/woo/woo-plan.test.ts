import { describe, expect, it } from "vitest";
import {
  WOO_COST_SENTINEL,
  WOO_HEADERS,
  syntheticWooRows,
  wooCsv,
  type WooFixtureRow,
} from "../../../../test/woo-fixture";
import { DEFAULT_IMPORT_LIMITS, parseImportFile, type ParsedTable } from "../import-file";
import {
  ImportMappingError,
  buildBrandIndex,
  buildCategoryIndex,
  type ExistingVariant,
  type ImportPlan,
  type PlannedRow,
} from "../import-plan";
import { emptyExistingSale } from "../import-sale";
import { detectWooColumns, looksLikeWooExport } from "./woo-columns";
import { DEFAULT_WOO_OPTIONS, collectWooLookups, planWoo, type WooSnapshot } from "./woo-plan";
import type {
  WooContext,
  WooCreateOp,
  WooOptions,
  WooSnapshotExtras,
  WooUpdateOp,
} from "./woo-types";

const CTX: WooContext = {
  // contul poate importa imagini (media.write), dar opțiunea e oprită în opțiunile implicite
  images: {
    allowedHosts: [],
    maxUrlLength: 2000,
    maxImagesPerProduct: 20,
    maxImagesPerImport: 2000,
  },
  timezone: "Europe/Bucharest",
  canSetLegacy: true,
};

async function tableOf(rows: WooFixtureRow[]): Promise<ParsedTable> {
  return parseImportFile(wooCsv(rows), DEFAULT_IMPORT_LIMITS);
}

function emptyExtras(over: Partial<WooSnapshotExtras> = {}): WooSnapshotExtras {
  return {
    categories: [],
    brands: [],
    attributes: [],
    variants: new Map(),
    products: new Map(),
    productIdBySku: new Map(),
    productIdByLegacyId: new Map(),
    variantIdByLegacyId: new Map(),
    mediaBySourceHash: new Map(),
    productMedia: new Map(),
    ...over,
  };
}

function snapshot(
  over: {
    categories?: { id: string; name: string; parentId: string | null }[];
    brands?: { id: string; name: string }[];
    extras?: Partial<WooSnapshotExtras>;
  } = {},
): WooSnapshot {
  const categories = over.categories ?? [];
  const brands = over.brands ?? [];
  return {
    variantsBySku: new Map(),
    slugOwners: new Map(),
    categoryIndex: buildCategoryIndex(categories),
    brandIndex: buildBrandIndex(brands),
    units: [],
    woo: emptyExtras({ categories, brands, ...over.extras }),
  };
}

async function plan(
  rows: WooFixtureRow[] = syntheticWooRows(),
  options: Partial<WooOptions> = {},
  snap: WooSnapshot = snapshot(),
  ctx = CTX,
): Promise<ImportPlan> {
  return planWoo(await tableOf(rows), { ...DEFAULT_WOO_OPTIONS, ...options }, snap, ctx);
}

const bySku = (p: ImportPlan, sku: string): PlannedRow => {
  const found = p.rows.find((r) => r.sku === sku);
  if (!found) throw new Error(`rând lipsă: ${sku}`);
  return found;
};
const textOf = (row: PlannedRow): string => row.messages.map((m) => m.text).join(" · ");

describe("recunoașterea coloanelor WooCommerce (antete în română)", () => {
  it("găsește rolurile, unitățile, grupurile de atribute și coloanele de ignorat sau blocate", () => {
    const map = detectWooColumns(WOO_HEADERS);
    expect(looksLikeWooExport(map)).toBe(true);
    expect(map.units).toEqual({ weight: "kg", dimensions: "cm" });
    expect(map.attributes.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(Object.keys(map.roles).sort()).toEqual(
      [
        "brands",
        "categories",
        "crossSells",
        "description",
        "gtin",
        "height",
        "id",
        "images",
        "length",
        "name",
        "parent",
        "published",
        "regularPrice",
        "saleFrom",
        "saleTo",
        "salePrice",
        "shippingClass",
        "shortDescription",
        "sku",
        "type",
        "upsells",
        "weight",
        "width",
      ].sort(),
    );
    // costul: blocat, nu ignorat
    expect(map.blocked).toEqual(["Meta: _pret_intrare"]);
    const ignored = Object.fromEntries(map.ignored.map((c) => [c.header, c.reason]));
    // prima coloană de imagini e sursa importului de imagini (15b), nu o coloană ignorată
    expect(map.roles.images).toBeDefined();
    expect(ignored["Imagini"]).toBeUndefined();
    expect(ignored["Stoc"]).toMatch(/stocul/);
    expect(ignored["În stoc?"]).toMatch(/stocul/);
    expect(ignored["Etichete"]).toMatch(/etichetele/);
    expect(ignored["Meta: _smartbill_sku"]).toMatch(/meta/);
    expect(ignored["Meta: _price_partener"]).toMatch(/meta/);
    expect(ignored["Produse grupate"]).toMatch(/grupate/);
    expect(Object.keys(ignored)).not.toContain("Meta: _pret_intrare");
  });

  it("un fișier care nu e export WooCommerce se refuză cu un mesaj clar", async () => {
    const table: ParsedTable = {
      format: "csv",
      delimiter: ";",
      delimiterSource: "detected",
      encoding: "utf-8",
      headers: ["SKU", "Titlu"],
      rows: [["A", "B"]],
      rowNumbers: [2],
      warnings: [],
    };
    expect(() => planWoo(table, DEFAULT_WOO_OPTIONS, snapshot(), CTX)).toThrow(ImportMappingError);
  });

  it("antete în engleză (export WooCommerce în engleză) se recunosc la fel", () => {
    const map = detectWooColumns([
      "ID",
      "Type",
      "SKU",
      "Name",
      "Published",
      "Regular price",
      "Sale price",
      "Categories",
      "Weight (kg)",
      "Length (cm)",
      "Parent",
      "Upsells",
      "Cross-sells",
      "Attribute 1 name",
      "Attribute 1 value(s)",
      "Shipping class",
      "Images",
    ]);
    expect(looksLikeWooExport(map)).toBe(true);
    expect(map.units).toEqual({ weight: "kg", dimensions: "cm" });
    expect(map.attributes).toHaveLength(1);
    expect(map.roles.crossSells).toBeDefined();
  });
});

describe("planificarea fixture-ului sintetic pe un catalog gol", () => {
  it("rezultatul pe rând: produse noi, variabil cu variații, tipuri neacceptate ignorate, rânduri murdare cu erori", async () => {
    const p = await plan();
    const outcome = (sku: string) => bySku(p, sku).outcome;
    expect(outcome("FIX-101")).toBe("new");
    expect(outcome("00123")).toBe("new");
    expect(outcome("WC-103")).toBe("new");
    expect(outcome("FIX-104")).toBe("new");
    expect(outcome("ID 200")).toBe("new"); // părintele variabil, fără SKU propriu
    expect(outcome("FIX-VAR-05")).toBe("new");
    expect(outcome("FIX-VAR-075")).toBe("new");
    expect(outcome("FIX-GRP")).toBe("skipped");
    expect(outcome("FIX-EXT")).toBe("skipped");
    for (const sku of ["FIX-105", "FIX-ORF", "FIX-108", "FIX-109", "FIX-110"]) {
      expect(outcome(sku), sku).toBe("error");
    }
    expect(p.counts).toMatchObject({ new: 7, skipped: 2, errors: 6, updated: 0, unchanged: 0 });
    expect(p.woo?.rowTypes).toEqual({
      simple: 9,
      variable: 1,
      variation: 3,
      grouped: 1,
      external: 1,
    });
  });

  it("produsul simplu complet: preț, promoție cu date în fusul magazinului, unități exacte, clasă, EAN, ciornă, ID vechi", async () => {
    const row = bySku(await plan(), "FIX-101");
    const op = row.op as WooCreateOp;
    expect(op.kind).toBe("woo-create");
    expect(op.product).toMatchObject({
      title: "Pompă de circulație Aqua 100",
      subtitle: "Silențioasă, clasa A",
      status: "draft",
      shippingClass: "pallet",
      brandKey: "marca fixture a",
    });
    const v = op.variants[0];
    expect(v).toMatchObject({
      sku: "FIX-101",
      price: 129_950,
      salePrice: 109_900,
      ean: "5901234123457",
      weightGrams: 12_500,
      lengthMm: 405,
      widthMm: 300,
      heightMm: 250,
    });
    // 1 nov 2026 00:00 și 30 nov 2026 23:59:59, ora României (EET, UTC+2)
    expect(v?.saleStartsAt).toBe("2026-10-31T22:00:00.000Z");
    expect(v?.saleEndsAt).toBe("2026-11-30T21:59:59.000Z");
    expect(op.legacyId).toBe("101");
    expect(op.product.categoryKeys).toEqual(["pompe>pompe de circulatie", "accesorii"]);
    // relații: id:103 se rezolvă în fișier (WC-103), id:104 la fel; NEEXISTENT-1 devine avertisment
    expect(op.relations).toEqual([
      { type: "upsell", target: { sku: "WC-103" } },
      { type: "crosssell", target: { sku: "FIX-104" } },
    ]);
    expect(textOf(row)).toContain("NEEXISTENT-1");
  });

  it("descrierea devine text simplu: tabel → «Etichetă: valoare», fără HTML, fără shortcode-uri; raport pe rând", async () => {
    const row = bySku(await plan(), "FIX-101");
    const description = (row.op as WooCreateOp).product.description as string;
    expect(description).toContain("Putere: 0,75 kW");
    expect(description).toContain("Debit maxim: 12 m³/h");
    expect(description).toContain("- Corp din material plastic");
    expect(description).toContain("fișa tehnică");
    expect(description).not.toMatch(/<\/?[a-z]/i);
    expect(description).not.toContain("caption");
    expect(description).not.toContain("exemplu.invalid");
    expect(description).not.toContain("color:blue");
    expect(textOf(row)).toMatch(
      /Descriere: HTML redus la text simplu \(1 tabel, 1 link, 1 imagine/,
    );
  });

  it("descrierea ostilă (script, iframe, eveniment) nu lasă nimic periculos", async () => {
    const op = bySku(await plan(), "WC-103").op as WooCreateOp;
    expect(op.product.description).toBe("Text normal & sigur.\n\nFinal");
    const everything = JSON.stringify(await plan());
    expect(everything).not.toMatch(/<script|<iframe|onclick|alert\(/i);
  });

  it("SKU numeric rămâne text; SKU lipsă devine WC-<ID> cu avertisment; clasa necunoscută → standard cu avertisment", async () => {
    const p = await plan();
    const numeric = bySku(p, "00123").op as WooCreateOp;
    expect(numeric.variants[0]?.sku).toBe("00123");
    expect(numeric.variants[0]).toMatchObject({ weightGrams: 500, lengthMm: 125, price: 34_990 });
    expect(numeric.product.shippingClass).toBe("oversized");
    expect(numeric.product.description).toBe(
      "Filtru pentru piscine de până la 40 m³.\nSe livrează cu ventil.",
    );

    const fallback = bySku(p, "WC-103");
    expect(textOf(fallback)).toMatch(/SKU lipsă în fișier: se folosește «WC-103»/);
    expect(textOf(fallback)).toMatch(/Curier special.*standard/);
    expect((fallback.op as WooCreateOp).product.shippingClass).toBe("standard");
    expect(p.woo?.stats).toMatchObject({ skuFallbacks: 1, unknownShippingClasses: 1 });
  });

  it("categoriile lipsă sunt LISTATE (părinții întâi), cu virgula escapată respectată; brandurile și atributele la fel", async () => {
    const p = await plan();
    const names = p.woo?.creations.categories.map((c) => c.names.join(" > "));
    expect(names).toEqual([
      "Accesorii",
      "Accesorii, diverse",
      "Filtrare",
      "Pompe",
      "Filtrare > Filtre cu nisip",
      "Pompe > Pompe de circulație",
    ]);
    expect(p.woo?.creations.brands.map((b) => b.name)).toEqual([
      "Marca Fixture A",
      "Marca Fixture B",
    ]);
    expect(p.woo?.creations.attributes.map((a) => [a.name, a.code])).toEqual([
      ["Material", "material"],
    ]);
    expect(p.woo?.stats).toMatchObject({
      categoriesToCreate: 6,
      brandsToCreate: 2,
      attributesToCreate: 1,
    });
    // rândul 109 (cu «|») și 108 (prea adânc) nu cer categorii în plus
    expect(names?.join("|")).not.toContain("N1");
  });

  it("produsul variabil: opțiunea «Putere», variațiile cu alegerea lor, atributul simplu, variațiile ca rânduri-copil", async () => {
    const p = await plan();
    const parent = bySku(p, "ID 200");
    const op = parent.op as WooCreateOp;
    expect(op.options).toEqual([{ name: "Putere", values: ["0,5 kW", "0,75 kW"] }]);
    expect(op.variants.map((v) => [v.sku, v.price, v.weightGrams, v.selections])).toEqual([
      ["FIX-VAR-05", 180_000, 7000, [{ option: "Putere", value: "0,5 kW" }]],
      ["FIX-VAR-075", 210_000, 8250, [{ option: "Putere", value: "0,75 kW" }]],
    ]);
    expect(op.variants[1]?.salePrice).toBe(195_000);
    expect(op.attributeValues).toEqual([{ key: "material", value: "Polipropilenă" }]);
    expect(op.childRows).toHaveLength(2);
    expect(bySku(p, "FIX-VAR-05").op).toEqual({ kind: "woo-child", parentRow: parent.row });
    expect(p.woo?.stats.variations).toBe(2);
  });

  it("rândurile murdare au motiv clar", async () => {
    const p = await plan();
    expect(textOf(bySku(p, "FIX-105"))).toMatch(/Preț obișnuit: valoare invalidă „abc”/);
    const duplicates = p.rows.filter((r) => r.sku === "FIX-101");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[1]?.outcome).toBe("error");
    expect(textOf(duplicates[1] as PlannedRow)).toMatch(/SKU repetat/);
    expect(textOf(bySku(p, "FIX-ORF"))).toMatch(/Variație fără produs variabil/);
    expect(textOf(bySku(p, "FIX-108"))).toMatch(/6 niveluri; arborele poate avea cel mult 5/);
    expect(textOf(bySku(p, "FIX-109"))).toMatch(/conține «\|»/);
    expect(textOf(bySku(p, "FIX-110"))).toMatch(/Greutate: nu e un număr întreg/);
    expect(textOf(bySku(p, "FIX-GRP"))).toMatch(/tipul «grouped» nu este acceptat/);
  });

  it("starea: implicit ciornă; cu «păstrează starea» publicat → activ, nepublicat → ciornă", async () => {
    const draft = await plan();
    expect((bySku(draft, "FIX-101").op as WooCreateOp).product.status).toBe("draft");
    const kept = await plan(undefined, { keepStatus: true });
    expect((bySku(kept, "FIX-101").op as WooCreateOp).product.status).toBe("active");
    expect((bySku(kept, "FIX-104").op as WooCreateOp).product.status).toBe("draft");
  });

  it("unitățile din opțiuni: greutate în g și dimensiuni în mm se iau ca atare; antet diferit dă avertisment", async () => {
    const rows = syntheticWooRows().filter((r) => r.SKU === "00123");
    const ok = await plan(
      rows.map((r) => ({ ...r, "Greutate (kg)": "250", "Lungime (cm)": "125" })),
      {
        weightUnit: "g",
        dimensionUnit: "mm",
      },
    );
    const v = (bySku(ok, "00123").op as WooCreateOp).variants[0];
    expect(v).toMatchObject({ weightGrams: 250, lengthMm: 125 });
    expect(ok.fileWarnings.join(" ")).toMatch(
      /Antetul de greutate spune «kg», dar importul folosește «g»/,
    );
    expect(ok.fileWarnings.join(" ")).toMatch(
      /dimensiunilor spune «cm», dar importul folosește «mm»/,
    );
    // 0,5 g nu e un număr întreg de grame
    const bad = await plan(rows, { weightUnit: "g" });
    expect(textOf(bySku(bad, "00123"))).toMatch(/Greutate: nu e un număr întreg/);
  });

  it("fără catalog.legacy.edit ID-ul din magazinul vechi nu se salvează (numărat), restul merge", async () => {
    const p = await plan(undefined, {}, snapshot(), { ...CTX, canSetLegacy: false });
    expect((bySku(p, "FIX-101").op as WooCreateOp).legacyId).toBeNull();
    expect(p.woo?.stats.legacyNotSaved).toBeGreaterThan(0);
    expect(bySku(p, "FIX-101").outcome).toBe("new");
  });

  it("prețul de achiziție (valoarea-santinelă) nu apare nicăieri în plan, raport sau avertismente", async () => {
    const p = await plan();
    expect(JSON.stringify(p)).not.toContain(WOO_COST_SENTINEL);
    expect(JSON.stringify(p)).not.toContain("7654321");
    expect(p.fileWarnings.join(" ")).toMatch(/«Meta: _pret_intrare» pare de cost/);
    // valorile prețurilor de grup (_price_partener) nu se importă
    expect(JSON.stringify(p)).not.toContain('"900"');
  });

  it("imaginile (opțiune oprită) și stocul se ignoră cu avertisment la nivel de fișier", async () => {
    const p = await plan();
    expect(p.fileWarnings.join("\n")).toMatch(/Coloana «Imagini» nu se importă/);
    expect(p.fileWarnings.join("\n")).toMatch(/Coloanele de stoc.*ignorate.*Faza 5/);
  });

  it("amprenta planului e stabilă la aceeași intrare și se schimbă când se schimbă catalogul", async () => {
    const a = await plan();
    const b = await plan();
    expect(a.fingerprint).toBe(b.fingerprint);
    const withBrand = await plan(
      undefined,
      {},
      snapshot({ brands: [{ id: "b1", name: "Marca Fixture A" }] }),
    );
    expect(withBrand.fingerprint).not.toBe(a.fingerprint);
    expect(withBrand.woo?.creations.brands.map((x) => x.name)).toEqual(["Marca Fixture B"]);
  });
});

describe("potrivirea cu ce există deja", () => {
  it("categorii existente (fără diferență de majuscule și diacritice) nu se dublează; doar ce lipsește se creează", async () => {
    const snap = snapshot({
      categories: [
        { id: "c1", name: "POMPE", parentId: null },
        { id: "c2", name: "Pompe de circulatie", parentId: "c1" },
      ],
    });
    const p = await plan(undefined, {}, snap);
    const names = p.woo?.creations.categories.map((c) => c.names.join(" > "));
    expect(names).not.toContain("Pompe");
    expect(names).not.toContain("Pompe > Pompe de circulație");
    expect(p.woo?.refs.categoryId["pompe>pompe de circulatie"]).toBe("c2");
  });

  it("un nume de categorie ambiguu în catalog dă eroare pe rând, nu o alegere la nimereală", async () => {
    const snap = snapshot({
      categories: [
        { id: "c1", name: "Accesorii", parentId: null },
        { id: "c2", name: "accesorii", parentId: null },
      ],
    });
    const p = await plan(undefined, {}, snap);
    expect(bySku(p, "FIX-104").outcome).toBe("new"); // «Accesorii, diverse» e alt nume
    expect(textOf(bySku(p, "FIX-101"))).toMatch(/se potrivește cu mai multe categorii/);
    expect(bySku(p, "FIX-101").outcome).toBe("error");
  });

  it("atributele: potrivire automată cu unul existent (după nume), «ignore» le scoate, «create» forțează crearea", async () => {
    const existing: WooSnapshotExtras["attributes"] = [
      { id: "a1", code: "material", name: "Material", type: "text", options: [] },
    ];
    const withExisting = await plan(undefined, {}, snapshot({ extras: { attributes: existing } }));
    expect(withExisting.woo?.creations.attributes).toEqual([]);
    expect(withExisting.woo?.refs.attributeId["material"]).toBe("a1");

    const ignored = await plan(undefined, { attributeTargets: { material: "ignore" } });
    expect(ignored.woo?.creations.attributes).toEqual([]);
    expect((bySku(ignored, "ID 200").op as WooCreateOp).attributeValues).toEqual([]);

    const forced = await plan(
      undefined,
      { attributeTargets: { material: "create" } },
      snapshot({ extras: { attributes: existing } }),
    );
    expect(forced.woo?.creations.attributes.map((a) => a.code)).toEqual(["material_2"]);
  });

  it("brand dublu în catalog = eroare; brand existent se referă prin id (fără creare)", async () => {
    const ok = await plan(
      undefined,
      {},
      snapshot({ brands: [{ id: "b1", name: "marca fixture a" }] }),
    );
    expect(ok.woo?.creations.brands.map((b) => b.name)).toEqual(["Marca Fixture B"]);
    expect(ok.woo?.refs.brandId["marca fixture a"]).toBe("b1");
    const dup = await plan(
      undefined,
      {},
      snapshot({
        brands: [
          { id: "b1", name: "Marca Fixture A" },
          { id: "b2", name: "marca fixture a" },
        ],
      }),
    );
    expect(bySku(dup, "FIX-101").outcome).toBe("error");
  });
});

describe("reimport: produs existent", () => {
  function existingFor(
    sku: string,
    product: Partial<ExistingVariant["product"]> = {},
  ): WooSnapshot {
    const snap = snapshot();
    (snap.variantsBySku as Map<string, ExistingVariant>).set(sku.toLowerCase(), {
      variantId: `v-${sku}`,
      productId: `p-${sku}`,
      sku,
      ean: null,
      price: 100,
      salePrice: null,
      warrantyMonths: null,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      sale: emptyExistingSale([`v-${sku}`]),
      product: {
        title: "Titlu vechi",
        slug: `slug-${sku.toLowerCase()}`,
        subtitle: null,
        description: null,
        status: "draft",
        deleted: false,
        brandId: null,
        shippingClass: "standard",
        categoryIds: [],
        ...product,
      },
    });
    return snap;
  }

  it("SKU existent → actualizare doar a ce diferă; celulele goale lasă valoarea neschimbată", async () => {
    const rows = syntheticWooRows().filter((r) => r.SKU === "FIX-104");
    const p = await plan(rows, {}, existingFor("FIX-104"));
    const row = bySku(p, "FIX-104");
    expect(row.outcome).toBe("updated");
    const op = row.op as WooUpdateOp;
    expect(op.productPatch).toMatchObject({ title: "Perie pentru fundul bazinului" });
    expect(op.variantPatch).toMatchObject({ price: 5_999 });
    // starea nu se atinge fără «păstrează starea»
    expect(op.productPatch).not.toHaveProperty("status");
  });

  it("produs arhivat sau din coș → ignorat cu motiv, nu actualizat în tăcere", async () => {
    const rows = syntheticWooRows().filter((r) => r.SKU === "FIX-104");
    const archived = await plan(rows, {}, existingFor("FIX-104", { status: "archived" }));
    expect(bySku(archived, "FIX-104").outcome).toBe("skipped");
    const deleted = await plan(rows, {}, existingFor("FIX-104", { deleted: true }));
    expect(textOf(bySku(deleted, "FIX-104"))).toMatch(/coșul de gunoi/);
  });

  it("variație nouă la un produs variabil existent = eroare clară (nu se adaugă variante la produse existente)", async () => {
    const rows = syntheticWooRows().filter((r) => ["200", "201", "202"].includes(r.ID ?? ""));
    const p = await plan(rows, {}, existingFor("FIX-VAR-05"));
    expect(bySku(p, "FIX-VAR-075").outcome).toBe("error");
    expect(textOf(bySku(p, "FIX-VAR-075"))).toMatch(/Variație nouă la un produs existent/);
  });
});

describe("colectarea căutărilor", () => {
  it("SKU-uri (cu WC-<ID> pentru lipsă), ID-uri vechi și țintele relațiilor", async () => {
    const table = await tableOf(syntheticWooRows());
    const lookups = collectWooLookups(table);
    expect(lookups.skus).toEqual(
      expect.arrayContaining(["FIX-101", "00123", "WC-103", "NEEXISTENT-1"]),
    );
    expect(lookups.legacyIds).toEqual(expect.arrayContaining(["101", "103", "104", "200"]));
  });
});
