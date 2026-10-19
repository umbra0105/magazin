import { describe, expect, it } from "vitest";
import {
  WOO_COST_SENTINEL,
  syntheticWooRows,
  wooCsv,
  type WooFixtureRow,
} from "../../../../test/woo-fixture";
import { parseImportFile, type ParsedTable } from "../import-file";
import { buildBrandIndex, buildCategoryIndex, type ImportPlan } from "../import-plan";
import { DEFAULT_IMPORT_LIMITS } from "../import-file";
import { DEFAULT_WOO_OPTIONS, collectWooLookups, planWoo, type WooSnapshot } from "./woo-plan";
import type { WooContext, WooOptions, WooSnapshotExtras } from "./woo-types";

/**
 * Planul de imagini al profilului WooCommerce: la verificare NU se face nicio cerere în rețea; adresele trec doar
 * prin regulile fără rețea (https, port, sintaxă, listă de domenii), iar planul arată ce se acceptă, de pe ce
 * domenii și ce se respinge, cu motivul și fără adresa completă.
 */

const IMAGES_ON = {
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

function extras(over: Partial<WooSnapshotExtras> = {}): WooSnapshotExtras {
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

const snapshot = (over: Partial<WooSnapshotExtras> = {}): WooSnapshot => ({
  variantsBySku: new Map(),
  slugOwners: new Map(),
  categoryIndex: buildCategoryIndex([]),
  brandIndex: buildBrandIndex([]),
  woo: extras(over),
});

async function plan(
  rows: WooFixtureRow[],
  options: Partial<WooOptions> = {},
  images: WooContext["images"] = IMAGES_ON,
  snap: WooSnapshot = snapshot(),
): Promise<ImportPlan> {
  return planWoo(
    await parse(rows),
    { ...DEFAULT_WOO_OPTIONS, importImages: true, ...options },
    snap,
    ctx(images),
  );
}

const simple = (sku: string, images: string): WooFixtureRow => ({
  ID: sku.replace(/\D/g, "") || "1",
  Tip: "simple",
  SKU: sku,
  Nume: `Produs ${sku}`,
  "Preț obișnuit": "100",
  Imagini: images,
});

const img = (name: string) => `https://exemplu.invalid/poze/${name}.jpg`;

describe("planul de imagini (fără rețea)", () => {
  it("adresele acceptate devin sarcini în ordinea din fișier, cu adresa normalizată și hash", async () => {
    const p = await plan([simple("A-1", `${img("a")}, ${img("b")}, ${img("c")}`)]);
    const images = p.woo?.images;
    expect(images?.enabled).toBe(true);
    expect(images?.tasks.map((t) => [t.position, t.sku, t.host, t.url])).toEqual([
      [0, "A-1", "exemplu.invalid", img("a")],
      [1, "A-1", "exemplu.invalid", img("b")],
      [2, "A-1", "exemplu.invalid", img("c")],
    ]);
    expect(images?.tasks[0]?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(images?.stats).toMatchObject({ total: 3, accepted: 3, rejected: 0 });
    expect(images?.stats.byHost).toEqual({ "exemplu.invalid": 3 });
  });

  it("gazda se normalizează (majuscule, punct final) înainte de potrivire", async () => {
    const p = await plan([simple("A-1", "https://EXEMPLU.invalid./poze/a.jpg")]);
    expect(p.woo?.images.tasks).toHaveLength(1);
    expect(p.woo?.images.tasks[0]?.url).toBe("https://exemplu.invalid/poze/a.jpg");
  });

  it("opțiunea oprită sau lipsa dreptului de media: nicio sarcină, cu explicație la nivel de fișier", async () => {
    const off = await plan([simple("A-1", img("a"))], { importImages: false });
    expect(off.woo?.images.enabled).toBe(false);
    expect(off.woo?.images.tasks).toEqual([]);
    expect(off.fileWarnings.join("\n")).toMatch(/opțiunea de import al imaginilor e oprită/);

    // fără drept de media, explicația despre drept are prioritate chiar dacă opțiunea e oprită
    const noRightOff = await plan([simple("A-1", img("a"))], { importImages: false }, null);
    expect(noRightOff.fileWarnings.join("\n")).toMatch(/media\.write/);
    expect(noRightOff.fileWarnings.join("\n")).not.toMatch(
      /opțiunea de import al imaginilor e oprită/,
    );

    const noRight = await plan([simple("A-1", img("a"))], {}, null);
    expect(noRight.woo?.images.enabled).toBe(false);
    expect(noRight.woo?.images.tasks).toEqual([]);
    expect(noRight.fileWarnings.join("\n")).toMatch(/media\.write/);
  });

  it("lista de domenii goală: nimic nu se acceptă, mesaj clar o singură dată", async () => {
    const p = await plan(
      [simple("A-1", `${img("a")}, ${img("b")}`)],
      {},
      {
        ...IMAGES_ON,
        allowedHosts: [],
      },
    );
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.stats.rejectedByReason).toEqual({ no_hosts_configured: 2 });
    // nu se repetă pe fiecare imagine în rând
    expect(p.rows[0]?.messages.filter((m) => /Imagine/.test(m.text))).toEqual([]);
  });

  it.each([
    ["http://exemplu.invalid/a.jpg", "scheme"],
    ["https://utilizator@exemplu.invalid/a.jpg", "credentials"],
    ["https://exemplu.invalid:8080/a.jpg", "port"],
    ["https://exemplu.invalid/a.jpg#x", "fragment"],
    ["https://10.0.0.5/a.jpg", "ip_literal"],
    ["https://0x7f.1/a.jpg", "ip_literal"],
    ["https://[::1]/a.jpg", "ip_literal"],
    ["https://localhost/a.jpg", "invalid"],
    ["https://169.254.169.254/latest/meta-data", "ip_literal"],
    ["https://alt-domeniu.invalid/a.jpg", "host_not_allowed"],
    ["https://exemplu.invalid.alt.invalid/a.jpg", "host_not_allowed"],
    ["https://sub.exemplu.invalid/a.jpg", "host_not_allowed"],
  ])("respinge %s (%s) fără nicio sarcină", async (url, reason) => {
    const p = await plan([simple("A-1", url)]);
    expect(p.woo?.images.tasks).toEqual([]);
    expect(p.woo?.images.stats.rejectedByReason).toEqual({ [reason]: 1 });
    expect(p.woo?.images.stats.rejected).toBe(1);
  });

  it("mesajul rândului numește domeniul și motivul, nu adresa completă", async () => {
    const p = await plan([simple("A-1", "https://alt-domeniu.invalid/secret/path?token=abc")]);
    const text = p.rows[0]?.messages.map((m) => m.text).join("\n") ?? "";
    expect(text).toMatch(/Imagine 1 \(alt-domeniu\.invalid\): domeniu nepermis/);
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("/secret/path");
    expect(JSON.stringify(p)).not.toContain("token=abc");
  });

  it("produsul rămâne valid chiar dacă imaginile lui sunt respinse", async () => {
    const p = await plan([simple("A-1", "http://exemplu.invalid/a.jpg")]);
    expect(p.rows[0]?.outcome).toBe("new");
    expect(p.counts.errors).toBe(0);
  });

  it("aceeași adresă de două ori pe produs: o singură sarcină", async () => {
    const p = await plan([simple("A-1", `${img("a")}, ${img("a")}`)]);
    expect(p.woo?.images.tasks).toHaveLength(1);
  });

  it("limita pe produs și limita pe import se aplică, cu motiv", async () => {
    const perProduct = await plan(
      [simple("A-1", `${img("a")}, ${img("b")}, ${img("c")}`)],
      {},
      {
        ...IMAGES_ON,
        maxImagesPerProduct: 2,
      },
    );
    expect(perProduct.woo?.images.tasks).toHaveLength(2);
    expect(perProduct.woo?.images.stats.rejectedByReason).toEqual({ too_many_for_product: 1 });

    const perImport = await plan(
      [simple("A-1", `${img("a")}, ${img("b")}`), simple("A-2", `${img("c")}, ${img("d")}`)],
      {},
      { ...IMAGES_ON, maxImagesPerImport: 3 },
    );
    expect(perImport.woo?.images.tasks).toHaveLength(3);
    expect(perImport.woo?.images.stats.rejectedByReason).toEqual({ too_many_for_import: 1 });
  });

  it("adresa prea lungă se respinge", async () => {
    const p = await plan(
      [simple("A-1", `https://exemplu.invalid/${"a".repeat(300)}.jpg`)],
      {},
      {
        ...IMAGES_ON,
        maxUrlLength: 100,
      },
    );
    expect(p.woo?.images.stats.rejectedByReason).toEqual({ too_long: 1 });
  });

  it("imaginile de pe variații se ignoră, cu avertisment; cele ale produsului variabil se iau", async () => {
    const p = await plan([
      {
        ID: "500",
        Tip: "variable",
        SKU: "VAR-1",
        Nume: "Produs variabil",
        Imagini: img("parinte"),
        "Nume atribut 1": "Culoare",
        "Valoare (valori) atribut 1": "Alb, Negru",
      },
      {
        ID: "501",
        Tip: "variation",
        SKU: "VAR-1-A",
        Părinte: "id:500",
        "Preț obișnuit": "100",
        Imagini: img("variatie"),
        "Nume atribut 1": "Culoare",
        "Valoare (valori) atribut 1": "Alb",
      },
      {
        ID: "502",
        Tip: "variation",
        SKU: "VAR-1-N",
        Părinte: "id:500",
        "Preț obișnuit": "100",
        "Nume atribut 1": "Culoare",
        "Valoare (valori) atribut 1": "Negru",
      },
    ] as WooFixtureRow[]);
    expect(p.woo?.images.tasks.map((t) => [t.sku, t.url])).toEqual([["VAR-1-A", img("parinte")]]);
    expect(p.woo?.images.stats.ignoredOnVariations).toBe(1);
    const warning = p.rows
      .find((r) => r.sku === "VAR-1-A")
      ?.messages.map((m) => m.text)
      .join("\n");
    expect(warning).toMatch(/Imagini: la variații se ignoră/);
  });

  it("rândurile cu erori sau ignorate nu produc sarcini", async () => {
    const bad = { ...simple("A-1", img("a")), "Preț obișnuit": "nu-e-preț" };
    const grouped = { ...simple("G-1", img("b")), Tip: "grouped" };
    const p = await plan([bad, grouped]);
    expect(p.woo?.images.tasks).toEqual([]);
  });

  it("imaginea deja adusă și atașată produsului existent nu mai produce sarcină; cea din bibliotecă se atașează fără descărcare", async () => {
    const first = await plan([simple("A-1", `${img("a")}, ${img("b")}`)]);
    const [a, b] = first.woo?.images.tasks ?? [];
    expect(a && b).toBeTruthy();
    const variantsBySku = new Map([
      [
        "a-1",
        {
          variantId: "v1",
          productId: "p1",
          sku: "A-1",
          ean: null,
          price: 10000,
          salePrice: null,
          warrantyMonths: null,
          weightGrams: null,
          lengthMm: null,
          widthMm: null,
          heightMm: null,
          product: {
            title: "Produs A-1",
            slug: "produs-a-1",
            subtitle: null,
            description: null,
            status: "draft",
            deleted: false,
            brandId: null,
            shippingClass: "standard",
            categoryIds: [],
          },
        },
      ],
    ]);
    const snap: WooSnapshot = {
      ...snapshot({
        mediaBySourceHash: new Map([
          [a?.sourceHash as string, "m-a"],
          [b?.sourceHash as string, "m-b"],
        ]),
        productMedia: new Map([["p1", new Set(["m-a"])]]),
        products: new Map([
          ["p1", { legacyId: null, attributes: new Map(), relations: new Set() }],
        ]),
        productIdBySku: new Map([["a-1", "p1"]]),
      }),
      variantsBySku: variantsBySku as WooSnapshot["variantsBySku"],
    };
    const p = await plan([simple("A-1", `${img("a")}, ${img("b")}`)], {}, IMAGES_ON, snap);
    expect(p.woo?.images.stats).toMatchObject({
      accepted: 2,
      alreadyAttached: 1,
      alreadyInLibrary: 1,
    });
    expect(p.woo?.images.tasks.map((t) => t.url)).toEqual([img("b")]);
    expect(p.woo?.images.tasks[0]?.position).toBe(1);
  });

  it("sarcinile și motivele respingerii intră în amprentă; schimbarea listei de domenii o schimbă", async () => {
    const rows = [simple("A-1", img("a"))];
    const allowed = await plan(rows);
    const same = await plan(rows);
    const blocked = await plan(rows, {}, { ...IMAGES_ON, allowedHosts: ["alt.invalid"] });
    expect(same.fingerprint).toBe(allowed.fingerprint);
    expect(blocked.fingerprint).not.toBe(allowed.fingerprint);
  });

  it("planul nu conține prețul de achiziție și nici adresele brute respinse", async () => {
    const p = await plan(
      syntheticWooRows().map((r) => ({ ...r, Imagini: "http://x.invalid/a.jpg?k=SECRET" })),
    );
    const json = JSON.stringify(p);
    expect(json).not.toContain(WOO_COST_SENTINEL);
    expect(json).not.toContain("SECRET");
  });
});

describe("colectarea căutărilor pentru imagini", () => {
  it("dă hash-urile adreselor valide (fără listă de domenii) ca să se afle fișierele deja aduse", async () => {
    const table = await parse([
      simple("A-1", `${img("a")}, http://exemplu.invalid/x.jpg, ${img("b")}`),
    ]);
    const lookups = collectWooLookups(table);
    expect(lookups.imageHashes).toHaveLength(2);
    for (const hash of lookups.imageHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
