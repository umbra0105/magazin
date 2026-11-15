import { describe, expect, it } from "vitest";
import { checkImageUrl } from "../../../media/image-url";
import { wooCsv, type WooFixtureRow } from "../../../../test/woo-fixture";
import { DEFAULT_IMPORT_LIMITS, parseImportFile, type ParsedTable } from "../import-file";
import {
  buildBrandIndex,
  buildCategoryIndex,
  type ExistingVariant,
  type ImportPlan,
} from "../import-plan";
import { DESCRIPTION_TOKEN_LENGTH } from "./description-images";
import { planWooDescriptions } from "./woo-descriptions-plan";
import { DEFAULT_WOO_OPTIONS, planWoo, type WooSnapshot } from "./woo-plan";
import type { WooContext, WooOptions, WooSnapshotExtras } from "./woo-types";

/**
 * Planul imaginilor din descrieri (15d), fără rețea: marcajele rămân în descriere, adresele acceptate devin sarcini cu tipul
 * `description`, cele respinse apar în raport cu motivul (fără adresă), iar imaginile deja aduse se înlocuiesc pe loc, deci o a
 * doua verificare dă «neschimbat». Fără opțiune, comportamentul din 15c rămâne: imaginile externe se elimină, cu contor.
 */

const POLICY = {
  allowedHosts: ["exemplu.invalid"],
  maxUrlLength: 2000,
  maxImagesPerProduct: 20,
  maxImagesPerImport: 2000,
};
const ctx = (images: WooContext["images"]): WooContext => ({
  images,
  timezone: "Europe/Bucharest",
  canSetLegacy: true,
});
const parse = (rows: WooFixtureRow[]): Promise<ParsedTable> =>
  parseImportFile(wooCsv(rows), DEFAULT_IMPORT_LIMITS);

const extras = (over: Partial<WooSnapshotExtras> = {}): WooSnapshotExtras => ({
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
});
const snapshot = (over: Partial<WooSnapshotExtras> = {}): WooSnapshot => ({
  variantsBySku: new Map(),
  slugOwners: new Map(),
  categoryIndex: buildCategoryIndex([]),
  brandIndex: buildBrandIndex([]),
  units: [],
  woo: extras(over),
});

const url = (name: string) => `https://exemplu.invalid/poze/${name}.jpg`;
const hashOf = (name: string) => {
  const result = checkImageUrl(url(name), POLICY);
  if (!result.ok) throw new Error("adresă de test invalidă");
  return result.sourceHash;
};
const token = (name: string) => `{{img:${hashOf(name).slice(0, DESCRIPTION_TOKEN_LENGTH)}}}`;

const row = (sku: string, description: string): WooFixtureRow => ({
  ID: sku.replace(/\D/g, "") || "1",
  Tip: "simple",
  SKU: sku,
  Nume: `Produs ${sku}`,
  "Preț obișnuit": "100",
  Descriere: description,
});

async function plan(
  rows: WooFixtureRow[],
  options: Partial<WooOptions> = {},
  images: WooContext["images"] = POLICY,
  snap: WooSnapshot = snapshot(),
): Promise<ImportPlan> {
  return planWoo(await parse(rows), { ...DEFAULT_WOO_OPTIONS, ...options }, snap, ctx(images));
}

const created = (p: ImportPlan) => {
  const op = p.rows[0]?.op;
  return op && op.kind === "woo-create" ? op.product.description : undefined;
};

describe("importul obișnuit cu importDescriptionImages", () => {
  it("imaginea din descriere rămâne marcaj în același loc și devine sarcină `description` cu adresa normalizată", async () => {
    const p = await plan([row("A-1", `<p>Înainte</p><p><img src="${url("a")}"></p><p>După</p>`)], {
      importDescriptionImages: true,
    });
    expect(created(p)).toBe(`<p>Înainte</p><p>${token("a")}</p><p>După</p>`);
    expect(p.woo?.images.tasks).toEqual([
      expect.objectContaining({
        kind: "description",
        sku: "A-1",
        position: 0,
        url: url("a"),
        sourceHash: hashOf("a"),
        host: "exemplu.invalid",
      }),
    ]);
    expect(p.woo?.images.description).toMatchObject({
      enabled: true,
      stats: { total: 1, accepted: 1, rejected: 0 },
    });
  });

  it("imaginile produsului (coloana «Imagini») și cele din descriere stau în același plan, dar au tipuri diferite", async () => {
    const p = await plan([{ ...row("A-1", `<img src="${url("d")}">`), Imagini: url("g") }], {
      importDescriptionImages: true,
      importImages: true,
    });
    expect(p.woo?.images.tasks.map((task) => [task.kind ?? "product", task.sourceHash])).toEqual([
      ["product", hashOf("g")],
      ["description", hashOf("d")],
    ]);
  });

  it("imaginile respinse (domeniu nepermis, http, relativă) dispar din descriere și apar în raport, fără adresa completă", async () => {
    const p = await plan(
      [
        row(
          "A-1",
          `<img src="https://alt.invalid/x.jpg"><img src="http://exemplu.invalid/y.jpg"><img src="/z.jpg"><img src="${url("a")}">`,
        ),
      ],
      { importDescriptionImages: true },
    );
    expect(created(p)).toBe(`<p>${token("a")}</p>`);
    const description = p.woo?.images.description;
    expect(description?.stats).toMatchObject({ total: 4, accepted: 1, rejected: 3 });
    expect(description?.stats.rejectedByReason).toEqual({
      host_not_allowed: 1,
      scheme: 1,
      invalid: 1,
    });
    expect(JSON.stringify(description?.issues)).not.toContain("x.jpg");
    expect(p.rows[0]?.messages.map((m) => m.text).join("\n")).toMatch(/3 imagini nu se aduc/);
  });

  it("imaginea deja în bibliotecă se înlocuiește pe loc, fără sarcină (a doua verificare dă aceeași descriere)", async () => {
    const snap = snapshot({ mediaBySourceHash: new Map([[hashOf("a"), "media_aaaa"]]) });
    const p = await plan(
      [row("A-1", `<p><img src="${url("a")}"></p>`)],
      {
        importDescriptionImages: true,
      },
      POLICY,
      snap,
    );
    expect(created(p)).toBe(`<p><img alt="" data-media-id="media_aaaa" /></p>`);
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.description?.stats.alreadyInLibrary).toBe(1);
  });

  it("un <img data-media-id> scris de mână în fișier nu ajunge în descriere, nici cu opțiunea pornită (doar id-urile puse de plan)", async () => {
    const snap = snapshot({ mediaBySourceHash: new Map([[hashOf("a"), "media_aaaa"]]) });
    const p = await plan(
      [row("A-1", `<p>x</p><img data-media-id="media_alt1" alt=""><img src="${url("a")}">`)],
      { importDescriptionImages: true },
      POLICY,
      snap,
    );
    expect(created(p)).toBe(`<p>x</p><img alt="" data-media-id="media_aaaa" />`);
    expect(created(p)).not.toContain("media_alt1");
  });

  it("opțiunea oprită: comportamentul din 15c (imaginea se elimină, contor `descriptionImages`), fără sarcini și fără raport de descrieri", async () => {
    const p = await plan([row("A-1", `<p>x</p><img src="${url("a")}">`)]);
    expect(created(p)).toBe("<p>x</p>");
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.description).toBeUndefined();
    expect(p.woo?.stats.descriptionImages).toBe(1);
  });

  it("fără dreptul de media: nicio sarcină, avertisment la nivel de fișier, imaginile se elimină ca în 15c", async () => {
    const p = await plan(
      [row("A-1", `<img src="${url("a")}">`)],
      { importDescriptionImages: true },
      null,
    );
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.description?.enabled).toBe(false);
    expect(p.fileWarnings.join("\n")).toMatch(
      /Imaginile din descrieri nu se importă.*media\.write/,
    );
  });

  it("limita pe import e comună: peste ea, restul imaginilor din descrieri se resping", async () => {
    const small = { ...POLICY, maxImagesPerImport: 2 };
    const p = await plan(
      [
        row("A-1", `<img src="${url("a")}"><img src="${url("b")}">`),
        row("A-2", `<img src="${url("c")}">`),
      ],
      { importDescriptionImages: true },
      small,
    );
    expect(p.woo?.images.tasks).toHaveLength(2);
    expect(p.woo?.images.description?.stats.rejectedByReason).toEqual({ too_many_for_import: 1 });
  });
});

describe("modul «doar descrieri» cu importDescriptionImages", () => {
  const existing = (sku: string, productId: string): ExistingVariant =>
    ({
      id: `v-${productId}`,
      productId,
      sku,
      product: { id: productId, description: null, deleted: false },
    }) as unknown as ExistingVariant;

  const snapWith = (
    sku: string,
    productId: string,
    over: Partial<WooSnapshotExtras> = {},
  ): WooSnapshot => ({
    ...snapshot({ productIdBySku: new Map([[sku.toLowerCase(), productId]]), ...over }),
    variantsBySku: new Map([[sku.toLowerCase(), existing(sku, productId)]]),
  });

  it("produsul care există și își schimbă descrierea primește marcaje și sarcini cu productId", async () => {
    const p = planWooDescriptions(
      await parse([row("A-1", `<p><img src="${url("a")}"></p>`)]),
      { overwriteEditedDescriptions: false, importDescriptionImages: true },
      snapWith("A-1", "p1"),
      { images: POLICY },
    );
    expect(p.rows[0]?.outcome).toBe("updated");
    const op = p.rows[0]?.op;
    expect(op && op.kind === "woo-update" ? op.productPatch?.description : null).toBe(
      `<p>${token("a")}</p>`,
    );
    expect(p.woo?.images.tasks).toEqual([
      expect.objectContaining({ kind: "description", productId: "p1", sku: "A-1" }),
    ]);
  });

  it("un rând care nu se actualizează (produs inexistent) nu produce sarcini", async () => {
    const p = planWooDescriptions(
      await parse([row("Z-9", `<img src="${url("a")}">`)]),
      { overwriteEditedDescriptions: false, importDescriptionImages: true },
      snapshot(),
      { images: POLICY },
    );
    expect(p.rows[0]?.outcome).toBe("skipped");
    expect(p.woo?.images.tasks).toEqual([]);
  });

  it("fără opțiune: sarcini zero, descrierea ca în 15c", async () => {
    const p = planWooDescriptions(
      await parse([row("A-1", `<p>x</p><img src="${url("a")}">`)]),
      { overwriteEditedDescriptions: false },
      snapWith("A-1", "p1"),
      { images: POLICY },
    );
    const op = p.rows[0]?.op;
    expect(op && op.kind === "woo-update" ? op.productPatch?.description : null).toBe("<p>x</p>");
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.description).toBeUndefined();
  });
});
