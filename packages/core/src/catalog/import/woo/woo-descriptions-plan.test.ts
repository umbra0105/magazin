import { describe, expect, it, vi } from "vitest";
import { WOO_HEADERS, wooCsv, type WooFixtureRow } from "../../../../test/woo-fixture";
import { DEFAULT_IMPORT_LIMITS, parseImportFile, type ParsedTable } from "../import-file";
import {
  ImportMappingError,
  buildBrandIndex,
  buildCategoryIndex,
  type ExistingVariant,
  type ImportPlan,
} from "../import-plan";
import { emptyExistingSale } from "../import-sale";
import { planWooDescriptions } from "./woo-descriptions-plan";
import { DEFAULT_WOO_OPTIONS, type WooSnapshot } from "./woo-plan";
import type { WooOptions, WooSnapshotExtras, WooUpdateOp } from "./woo-types";

/**
 * Modul «doar descrieri» al profilului WooCommerce (15c, pasul 8): planificatorul schimbă DOAR descrierea produselor
 * care există deja. Nu creează produse, categorii, branduri sau atribute, nu atinge prețuri, nu aduce imagini. O descriere
 * editată manual după un import se păstrează, în afară de cazul în care se cere explicit suprascrierea.
 */

const OPTIONS: WooOptions = { ...DEFAULT_WOO_OPTIONS, mode: "descriptionsOnly" };

type Info = { description: string | null; deleted: boolean; manuallyEdited: boolean };

const table = (rows: WooFixtureRow[]): Promise<ParsedTable> =>
  parseImportFile(wooCsv(rows), DEFAULT_IMPORT_LIMITS);

function variant(
  sku: string,
  productId: string,
  description: string | null,
  deleted = false,
): ExistingVariant {
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
    sale: emptyExistingSale([`v-${sku}`]),
    product: {
      title: `Produs ${sku}`,
      slug: `produs-${sku.toLowerCase()}`,
      subtitle: null,
      description,
      status: "active",
      deleted,
      brandId: null,
      shippingClass: "standard",
      categoryIds: [],
    },
  };
}

const info = (
  description: string | null,
  over: Partial<Pick<Info, "deleted" | "manuallyEdited">> = {},
): Info => ({ description, deleted: false, manuallyEdited: false, ...over });

function snapshotOf(over: {
  variants?: ExistingVariant[];
  legacy?: Record<string, string>;
  info?: Record<string, Info>;
}): WooSnapshot {
  const extras: WooSnapshotExtras = {
    categories: [],
    brands: [],
    attributes: [],
    variants: new Map(),
    products: new Map(),
    productIdBySku: new Map(),
    productIdByLegacyId: new Map(Object.entries(over.legacy ?? {})),
    variantIdByLegacyId: new Map(),
    mediaBySourceHash: new Map(),
    productMedia: new Map(),
    descriptionInfo: new Map(Object.entries(over.info ?? {})),
  };
  return {
    variantsBySku: new Map((over.variants ?? []).map((v) => [v.sku.toLowerCase(), v])),
    slugOwners: new Map(),
    categoryIndex: buildCategoryIndex([]),
    brandIndex: buildBrandIndex([]),
    units: [],
    woo: extras,
  };
}

const simple = (
  id: string,
  sku: string,
  description: string,
  extra: WooFixtureRow = {},
): WooFixtureRow => ({
  ID: id,
  Tip: "simple",
  SKU: sku,
  Nume: `Produs ${sku}`,
  Descriere: description,
  "Preț obișnuit": "100",
  ...extra,
});

async function plan(
  rows: WooFixtureRow[],
  snapshot: WooSnapshot,
  options: Partial<WooOptions> = {},
): Promise<ImportPlan> {
  return planWooDescriptions(await table(rows), { ...OPTIONS, ...options }, snapshot);
}

const textOf = (p: ImportPlan, index = 0): string =>
  (p.rows[index]?.messages ?? []).map((m) => m.text).join(" · ");

describe("planWooDescriptions: ce se schimbă", () => {
  it("o descriere diferită → «actualizat», cu un patch DOAR pe descriere", async () => {
    const p = await plan(
      [simple("11", "A-1", "<p>Nouă</p>")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Veche</p>")],
        info: { p1: info("<p>Veche</p>") },
      }),
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      row: 2,
      sku: "A-1",
      outcome: "updated",
      changed: ["Descriere"],
    });
    expect(p.rows[0]?.op).toEqual({
      kind: "woo-update",
      productId: "p1",
      variantId: null,
      productPatch: { description: "<p>Nouă</p>" },
      variantPatch: null,
      legacyProduct: null,
      legacyVariant: null,
      attributeValues: [],
      relations: [],
    } satisfies WooUpdateOp);
    expect(p.counts).toMatchObject({ new: 0, updated: 1, unchanged: 0, skipped: 0, errors: 0 });
  });

  it("aceeași descriere (text simplu în fișier, HTML în bază) → «neschimbat»", async () => {
    const p = await plan(
      [simple("11", "A-1", "Aceeași\nlinie")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Aceeași<br />linie</p>")],
        info: { p1: info("<p>Aceeași<br />linie</p>") },
      }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "unchanged", op: null });
    expect(p.counts).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it("produsul se găsește după ID-ul din magazinul vechi, chiar dacă SKU-ul din fișier nu există", async () => {
    const p = await plan(
      [simple("77", "SKU-NOU", "<p>Din Woo</p>")],
      snapshotOf({ legacy: { "77": "p9" }, info: { p9: info("<p>Altceva</p>") } }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "updated" });
    expect((p.rows[0]?.op as WooUpdateOp).productId).toBe("p9");
  });

  it("produsul variabil se găsește prin SKU-ul unei variații; variațiile nu apar ca rânduri", async () => {
    const rows: WooFixtureRow[] = [
      {
        ID: "200",
        Tip: "variable",
        SKU: "",
        Nume: "Sistem",
        Descriere: "<p>Descrierea sistemului</p>",
      },
      { ID: "201", Tip: "variation", SKU: "K-1", Nume: "Sistem 1", Părinte: "id:200" },
      { ID: "202", Tip: "variation", SKU: "K-2", Nume: "Sistem 2", Părinte: "id:200" },
    ];
    const p = await plan(
      rows,
      snapshotOf({ variants: [variant("K-2", "p5", null)], info: { p5: info(null) } }),
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ sku: "K-2", outcome: "updated" });
    expect((p.rows[0]?.op as WooUpdateOp).productId).toBe("p5");
    expect(p.fileWarnings.join(" ")).toMatch(/2 rânduri de variații/);
  });

  it("descrierea goală din fișier nu șterge niciodată descrierea din magazin", async () => {
    const p = await plan(
      [simple("11", "A-1", "")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Rămâne</p>")],
        info: { p1: info("<p>Rămâne</p>") },
      }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "unchanged", op: null, changed: [], messages: [] });
  });
});

describe("planWooDescriptions: produse variabile, tipuri și rânduri neidentificabile", () => {
  const kid = (id: string, sku: string, parent: string): WooFixtureRow => ({
    ID: id,
    Tip: "variation",
    SKU: sku,
    Nume: `Variație ${sku}`,
    Părinte: parent,
  });
  const existing = snapshotOf({
    variants: [variant("K-1", "p5", null)],
    info: { p5: info(null) },
  });

  it("variațiile pot arăta spre părinte prin «id:<ID>», <ID> sau SKU-ul părintelui", async () => {
    for (const [parentSku, ref] of [
      ["", "id:200"],
      ["", "200"],
      ["PARENT-1", "PARENT-1"],
    ] as const) {
      const p = await plan(
        [
          { ID: "200", Tip: "variable", SKU: parentSku, Nume: "Sistem", Descriere: "<p>Nou</p>" },
          kid("201", "K-1", ref),
        ],
        existing,
      );
      expect(p.rows, ref).toHaveLength(1);
      expect(p.rows[0], ref).toMatchObject({ sku: "K-1", outcome: "updated" });
    }
  });

  it("un singur rând de variație: mesajul e la singular", async () => {
    const p = await plan(
      [
        { ID: "200", Tip: "variable", SKU: "", Nume: "Sistem", Descriere: "<p>Nou</p>" },
        kid("201", "K-1", "id:200"),
      ],
      existing,
    );
    expect(p.fileWarnings.join(" ")).toMatch(/1 rând de variație nu apare/);
  });

  it("variațiile aceluiași produs variabil, în produse diferite din magazin, nu se ating", async () => {
    const p = await plan(
      [
        { ID: "200", Tip: "variable", SKU: "", Nume: "Sistem", Descriere: "<p>Nou</p>" },
        kid("201", "K-1", "id:200"),
        kid("202", "K-2", "id:200"),
      ],
      snapshotOf({
        variants: [variant("K-1", "p5", null), variant("K-2", "p6", null)],
        info: { p5: info(null), p6: info(null) },
      }),
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/aparțin unor produse diferite/);
  });

  it("produsul variabil fără variații în fișier și fără ID cunoscut: nu se găsește, nu se creează", async () => {
    const p = await plan(
      [{ ID: "200", Tip: "variable", SKU: "", Nume: "Sistem", Descriere: "<p>Nou</p>" }],
      existing,
    );
    expect(p.rows[0]).toMatchObject({ sku: "ID 200", outcome: "skipped", op: null });
    expect(p.woo?.stats.productsNotFound).toBe(1);
  });

  it("tipurile neacceptate (grupat, extern) se ignoră cu motiv, fără să fie căutate ca produse", async () => {
    const p = await plan(
      [
        { ID: "300", Tip: "grouped", SKU: "A-1", Nume: "Grup", Descriere: "<p>Nou</p>" },
        { ID: "301", Tip: "external", SKU: "", Nume: "Extern", Descriere: "<p>Nou</p>" },
      ],
      snapshotOf({ variants: [variant("A-1", "p1", null)], info: { p1: info(null) } }),
    );
    expect(p.rows.map((r) => [r.sku, r.outcome])).toEqual([
      ["A-1", "skipped"],
      ["ID 301", "skipped"],
    ]);
    expect(textOf(p, 0)).toMatch(/tipul «grouped» nu este acceptat/);
    expect(p.woo?.stats.productsNotFound).toBe(0);
    expect(p.woo?.rowTypes).toEqual({ grouped: 1, external: 1 });
  });

  it("un rând fără SKU și fără ID nu se poate identifica: ignorat", async () => {
    const p = await plan([simple("", "", "<p>Nou</p>")], snapshotOf({}));
    expect(p.rows[0]).toMatchObject({ sku: "", outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/SKU și ID lipsă/);
    expect(p.woo?.stats.productsNotFound).toBe(0);
  });

  it("fără SKU, produsul simplu se caută după «WC-<ID>»", async () => {
    const p = await plan(
      [simple("103", "", "<p>Nou</p>")],
      snapshotOf({
        variants: [variant("WC-103", "p3", null)],
        info: { p3: info(null) },
      }),
    );
    expect(p.rows[0]).toMatchObject({ sku: "WC-103", outcome: "updated" });
  });

  it("produsul din coș găsit doar prin varianta lui (fără informații de descriere) se ignoră", async () => {
    const p = await plan(
      [simple("11", "A-1", "<p>Nou</p>")],
      snapshotOf({ variants: [variant("A-1", "p1", "<p>Veche</p>", true)] }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/coșul de gunoi/);
  });

  it("descrierea curentă vine din informațiile încărcate, nu din varianta găsită", async () => {
    // produs găsit doar după ID-ul vechi (nicio variantă): descrierea din informații decide
    const legacy = await plan(
      [simple("77", "SKU-NOU", "<p>La fel</p>")],
      snapshotOf({ legacy: { "77": "p9" }, info: { p9: info("<p>La fel</p>") } }),
    );
    expect(legacy.rows[0]).toMatchObject({ outcome: "unchanged" });
    // informațiile sunt autoritatea chiar dacă varianta spune altceva
    const authority = await plan(
      [simple("11", "A-1", "<p>X</p>")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>X</p>")],
        info: { p1: info("<p>Y</p>") },
      }),
    );
    expect(authority.rows[0]).toMatchObject({ outcome: "updated" });
  });

  it("fără informații încărcate, descrierea curentă se ia din varianta găsită", async () => {
    const same = await plan(
      [simple("11", "A-1", "<p>La fel</p>")],
      snapshotOf({ variants: [variant("A-1", "p1", "<p>La fel</p>")] }),
    );
    expect(same.rows[0]).toMatchObject({ outcome: "unchanged" });
    const other = await plan(
      [simple("11", "A-1", "<p>Altfel</p>")],
      snapshotOf({ variants: [variant("A-1", "p1", "<p>La fel</p>")] }),
    );
    expect(other.rows[0]).toMatchObject({ outcome: "updated" });
  });

  it("o eroare neașteptată a sanitizatorului (alta decât «prea lung») nu se înghite", async () => {
    vi.resetModules();
    vi.doMock("../../rich-text/description", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      sanitizeDescription: () => {
        throw new Error("boom");
      },
    }));
    const { planWooDescriptions: mocked } = await import("./woo-descriptions-plan");
    const parsed = await table([simple("11", "A-1", "<p>Nou</p>")]);
    expect(() =>
      mocked(parsed, OPTIONS, snapshotOf({ variants: [variant("A-1", "p1", null)] })),
    ).toThrow("boom");
    vi.doUnmock("../../rich-text/description");
  });

  it("o descriere care după curățare nu mai are nimic (doar script) nu șterge nimic: neschimbat, cu mesaj", async () => {
    const p = await plan(
      [simple("11", "A-1", "<script>alert(1)</script>")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Rămâne</p>")],
        info: { p1: info("<p>Rămâne</p>") },
      }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "unchanged", op: null });
    expect(textOf(p)).toMatch(/nu a rămas nimic; descrierea din magazin rămâne/);
  });
});

describe("planWooDescriptions: ce se ignoră", () => {
  it("produs inexistent → ignorat, cu motiv; nu se creează nimic", async () => {
    const p = await plan([simple("11", "NU-EXISTA", "<p>x</p>")], snapshotOf({}));
    expect(p.rows[0]).toMatchObject({ outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/nu există în magazin.*nu creează produse/);
    expect(p.woo?.stats.productsNotFound).toBe(1);
  });

  it("produs din coșul de gunoi → ignorat", async () => {
    const p = await plan(
      [simple("11", "A-1", "<p>x</p>")],
      snapshotOf({
        variants: [variant("A-1", "p1", null)],
        info: { p1: info(null, { deleted: true }) },
      }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "skipped" });
    expect(textOf(p)).toMatch(/coșul de gunoi/);
  });

  it("două rânduri pentru același produs: al doilea e ignorat", async () => {
    const p = await plan(
      [simple("11", "A-1", "<p>Prima</p>"), simple("12", "A-1", "<p>A doua</p>")],
      snapshotOf({ variants: [variant("A-1", "p1", null)], info: { p1: info(null) } }),
    );
    expect(p.rows.map((r) => r.outcome)).toEqual(["updated", "skipped"]);
    expect(textOf(p, 1)).toMatch(/același produs/);
    expect((p.rows[0]?.op as WooUpdateOp).productPatch).toEqual({ description: "<p>Prima</p>" });
  });

  it("modulul nu atinge nimic în afară de descriere: categorii, branduri, prețuri, imagini, atribute", async () => {
    const p = await plan(
      [
        simple("11", "A-1", "<p>Nouă</p>", {
          Categorii: "Noi > Noua",
          Branduri: "Marca Nouă",
          "Preț obișnuit": "999",
          "Preț promoțional": "500",
          Imagini: "https://exemplu.invalid/p.jpg",
          "Nume atribut 1": "Material",
          "Valoare (valori) atribut 1": "Plastic",
        }),
      ],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Veche</p>")],
        info: { p1: info("<p>Veche</p>") },
      }),
    );
    expect(p.woo?.creations).toEqual({ categories: [], brands: [], attributes: [] });
    expect(p.woo?.refs).toEqual({ categoryId: {}, brandId: {}, attributeId: {} });
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.enabled).toBe(false);
    expect(p.woo?.stats).toMatchObject({
      categoriesToCreate: 0,
      brandsToCreate: 0,
      attributesToCreate: 0,
    });
    const op = p.rows[0]?.op as WooUpdateOp;
    expect(op.productPatch).toEqual({ description: "<p>Nouă</p>" });
    expect(op.variantPatch).toBeNull();
    expect(op.brandKey).toBeUndefined();
    expect(op.categoryKeys).toBeUndefined();
    expect(p.fileWarnings.join(" ")).toMatch(/doar descrierile/);
  });
});

describe("planWooDescriptions: descrierile editate manual", () => {
  const manual = snapshotOf({
    variants: [variant("A-1", "p1", "<p>Editată de om</p>")],
    info: { p1: info("<p>Editată de om</p>", { manuallyEdited: true }) },
  });

  it("se păstrează (ignorat, cu motiv) când fișierul are altă descriere", async () => {
    const p = await plan([simple("11", "A-1", "<p>Din Woo</p>")], manual);
    expect(p.rows[0]).toMatchObject({ outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/editată manual.*se păstrează/);
    expect(p.woo?.stats.descriptionsKeptEdited).toBe(1);
    expect(p.counts).toMatchObject({ updated: 0, skipped: 1 });
  });

  it("cu suprascrierea cerută explicit, se înlocuiește", async () => {
    const p = await plan([simple("11", "A-1", "<p>Din Woo</p>")], manual, {
      overwriteEditedDescriptions: true,
    });
    expect(p.rows[0]).toMatchObject({ outcome: "updated" });
    expect(p.woo?.stats.descriptionsKeptEdited).toBe(0);
  });

  it("dacă fișierul are chiar descrierea din magazin, e «neschimbat» (nu «păstrat»)", async () => {
    const p = await plan([simple("11", "A-1", "<p>Editată de om</p>")], manual);
    expect(p.rows[0]).toMatchObject({ outcome: "unchanged" });
    expect(p.woo?.stats.descriptionsKeptEdited).toBe(0);
  });

  it("o descriere needitată manual (doar din import) se înlocuiește fără suprascriere explicită", async () => {
    const p = await plan(
      [simple("11", "A-1", "<p>Din Woo</p>")],
      snapshotOf({
        variants: [variant("A-1", "p1", "<p>Din import</p>")],
        info: { p1: info("<p>Din import</p>") },
      }),
    );
    expect(p.rows[0]).toMatchObject({ outcome: "updated" });
  });
});

describe("planWooDescriptions: curățarea HTML-ului", () => {
  const existing = snapshotOf({
    variants: [variant("A-1", "p1", null)],
    info: { p1: info(null) },
  });

  it("HTML ostil se curăță; raportul spune ce s-a pierdut; statisticile se numără", async () => {
    const p = await plan(
      [
        simple(
          "11",
          "A-1",
          '<p>ok</p><script>alert(1)</script><img src="https://exemplu.invalid/x.png">[caption id="a"]Poză[/caption]<table><tr><td>a</td></tr></table><a href="https://exemplu.ro/x">l</a>',
        ),
      ],
      existing,
    );
    const op = p.rows[0]?.op as WooUpdateOp;
    expect(op.productPatch).toEqual({
      description:
        '<p>ok</p>Poză<table><tr><td>a</td></tr></table><a href="https://exemplu.ro/x" target="_blank" rel="noopener noreferrer">l</a>',
    });
    expect(textOf(p)).toMatch(
      /Descriere: HTML curățat, eliminat: 1 imagine externă, 1 element nepermis \(script, iframe, stil…\), 2 shortcode-uri WordPress/,
    );
    expect(p.woo?.stats).toMatchObject({
      descriptionsSanitized: 1,
      descriptionTables: 1,
      descriptionLinks: 1,
      descriptionImages: 1,
      descriptionShortcodes: 2,
    });
  });

  it("o descriere peste limită nu se taie: rândul e ignorat, cu avertisment", async () => {
    // 25.000 de «&» devin 125.000 de caractere de HTML («&amp;»): peste limita de 100.000
    const p = await plan([simple("11", "A-1", "&".repeat(25_000))], existing);
    expect(p.rows[0]).toMatchObject({ outcome: "skipped", op: null });
    expect(textOf(p)).toMatch(/Descriere: .*depășește.*nu a fost importată/);
  });
});

describe("planWooDescriptions: amprenta și fișierul", () => {
  const snap = snapshotOf({
    variants: [variant("A-1", "p1", "<p>Veche</p>")],
    info: { p1: info("<p>Veche</p>") },
  });

  it("amprenta se schimbă odată cu descrierea și rămâne aceeași pentru aceleași date", async () => {
    const one = await plan([simple("11", "A-1", "<p>Una</p>")], snap);
    const same = await plan([simple("11", "A-1", "<p>Una</p>")], snap);
    const other = await plan([simple("11", "A-1", "<p>Alta</p>")], snap);
    expect(one.fingerprint).toBe(same.fingerprint);
    expect(one.fingerprint).not.toBe(other.fingerprint);
  });

  it("amprenta depinde și de suprascrierea editatelor manual", async () => {
    const manual = snapshotOf({
      variants: [variant("A-1", "p1", "<p>Om</p>")],
      info: { p1: info("<p>Om</p>", { manuallyEdited: true }) },
    });
    const kept = await plan([simple("11", "A-1", "<p>Woo</p>")], manual);
    const overwrite = await plan([simple("11", "A-1", "<p>Woo</p>")], manual, {
      overwriteEditedDescriptions: true,
    });
    expect(kept.fingerprint).not.toBe(overwrite.fingerprint);
  });

  it("un fișier care nu e export WooCommerce se refuză clar", async () => {
    const notWoo = await parseImportFile(
      new TextEncoder().encode("SKU;Titlu\nA;B\n"),
      DEFAULT_IMPORT_LIMITS,
    );
    expect(() => planWooDescriptions(notWoo, OPTIONS, snapshotOf({}))).toThrow(ImportMappingError);
  });

  it("antetul fixture-ului are coloana «Descriere» (garda testelor)", () => {
    expect(WOO_HEADERS).toContain("Descriere");
  });
});
