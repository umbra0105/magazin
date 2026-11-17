import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { CatalogReader, type CatalogSettings } from "./catalog-reader";
import { EMPTY_FILTERS, parseListingFilters, type ListingFilters } from "./listing-filters";

const db = getDb();
afterAll(() => db.$disconnect());

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
});
const NOW = new Date("2030-06-15T12:00:00Z");
const uid = (): string => randomUUID().slice(0, 8);
const settings: CatalogSettings = {
  showSalePricing: false,
  productsPerPage: 24,
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
};
const SORT = { sort: "recommended" as const, offset: 0, limit: 100 };

async function product(
  tx: TestTx,
  data: {
    title?: string;
    sku?: string;
    brandId?: string;
    status?: string;
    categoryId?: string;
  } = {},
) {
  const slug = `p-${uid()}`;
  return tx.product.create({
    data: {
      slug,
      title: data.title ?? `Produs ${slug}`,
      status: data.status ?? "active",
      manageStock: false,
      publishedAt: NOW,
      ...(data.brandId && { brandId: data.brandId }),
      variants: { create: { sku: data.sku ?? `SKU-${uid()}`, price: 10000, isDefault: true } },
      ...(data.categoryId && {
        categories: { create: { categoryId: data.categoryId, isPrimary: true } },
      }),
    },
  });
}

async function withReader<T>(fn: (reader: CatalogReader, tx: TestTx) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    return fn(new CatalogReader({ db: tx, storage, now: () => NOW }), tx);
  });
}

async function category(tx: TestTx) {
  const slug = `cat-${uid()}`;
  return tx.category.create({ data: { slug, name: slug, path: slug, depth: 0 } });
}

async function numberAttribute(tx: TestTx, code: string, opts: { filterable?: boolean } = {}) {
  return tx.attribute.create({
    data: {
      code,
      name: code,
      type: "number",
      unit: "mc/h",
      isFilterable: opts.filterable ?? true,
    },
  });
}

const setNumber = (tx: TestTx, productId: string, attributeId: string, value: number) =>
  tx.attributeValue.create({ data: { productId, attributeId, numberValue: value } });

const f = (params: Record<string, string>): ListingFilters => parseListingFilters(params);
const ids = (r: { items: { id: string }[] }) => new Set(r.items.map((i) => i.id));

describe("filtre: marcă și interval numeric", () => {
  it("marcă: selecție multiplă (SAU între mărci), restul exclus", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const [a, b, c] = await Promise.all(
        ["a", "b", "c"].map((n) =>
          tx.brand.create({ data: { slug: `m-${n}-${uid()}`, name: `Marca ${n}` } }),
        ),
      );
      const pa = await product(tx, { brandId: a!.id, categoryId: cat.id });
      const pb = await product(tx, { brandId: b!.id, categoryId: cat.id });
      await product(tx, { brandId: c!.id, categoryId: cat.id });
      const scope = { categoryPath: cat.path, filters: f({ marca: `${a!.slug},${b!.slug}` }) };
      const result = await reader.listProducts(scope, SORT, settings);
      expect(ids(result)).toEqual(new Set([pa.id, pb.id]));
      expect(result.total).toBe(2);
    });
  });

  it("interval: inclusiv la capete, doar minim, doar maxim, exact; produsele fără valoare ies", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const attr = await numberAttribute(tx, `debit_${uid()}`.replace(/-/g, "_"));
      const made: Record<number, string> = {};
      for (const value of [10, 20, 30]) {
        const p = await product(tx, { categoryId: cat.id });
        await setNumber(tx, p.id, attr.id, value);
        made[value] = p.id;
      }
      const withoutValue = await product(tx, { categoryId: cat.id });
      const run = async (range: string) =>
        ids(
          await reader.listProducts(
            { categoryPath: cat.path, filters: f({ [`f_${attr.code}`]: range }) },
            SORT,
            settings,
          ),
        );
      expect(await run("10-20")).toEqual(new Set([made[10], made[20]]));
      expect(await run("15-25")).toEqual(new Set([made[20]]));
      expect(await run("20-")).toEqual(new Set([made[20], made[30]]));
      expect(await run("-20")).toEqual(new Set([made[10], made[20]]));
      expect(await run("30")).toEqual(new Set([made[30]]));
      expect((await run("0-100")).has(withoutValue.id)).toBe(false);
    });
  });

  it("un atribut care nu e filtrabil nu filtrează: filtrul se ignoră la sanitizare, nu produce o listă goală", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const hidden = await numberAttribute(tx, `ascuns_${uid()}`.replace(/-/g, "_"), {
        filterable: false,
      });
      const p = await product(tx, { categoryId: cat.id });
      await setNumber(tx, p.id, hidden.id, 5);
      const filters = await reader.sanitizeFilters(
        f({ [`f_${hidden.code}`]: "100-200", f_inexistent: "1-2" }),
      );
      expect(filters).toEqual({ brands: [], ranges: {}, options: {} });
      const result = await reader.listProducts({ categoryPath: cat.path, filters }, SORT, settings);
      expect(ids(result)).toEqual(new Set([p.id]));
    });
  });
});

describe("faceted: contorizări și limite", () => {
  it("mărcile se numără cu celelalte filtre, dar fără filtrul propriu; marca aleasă e marcată", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const attr = await numberAttribute(tx, `putere_${uid()}`.replace(/-/g, "_"));
      const a = await tx.brand.create({ data: { slug: `m-a-${uid()}`, name: "Alfa" } });
      const b = await tx.brand.create({ data: { slug: `m-b-${uid()}`, name: "Beta" } });
      // Alfa: 2 produse (5 și 50), Beta: 1 produs (50)
      for (const [brand, value] of [
        [a, 5],
        [a, 50],
        [b, 50],
      ] as const) {
        const p = await product(tx, { brandId: brand.id, categoryId: cat.id });
        await setNumber(tx, p.id, attr.id, value);
      }
      const base = { categoryPath: cat.path };
      const none = await reader.getFacets({ ...base, filters: EMPTY_FILTERS });
      expect(none.brands.map((x) => [x.name, x.count])).toEqual([
        ["Alfa", 2],
        ["Beta", 1],
      ]);

      // cu marca Alfa aleasă, Beta rămâne în panou cu numărul ei (filtrul propriu nu restrânge grupa)
      const chosen = await reader.getFacets({ ...base, filters: f({ marca: a.slug }) });
      expect(chosen.brands.map((x) => [x.name, x.count, x.selected])).toEqual([
        ["Alfa", 2, true],
        ["Beta", 1, false],
      ]);

      // cu intervalul 40-60 pe putere, mărcile se numără doar pe produsele din interval
      const ranged = await reader.getFacets({
        ...base,
        filters: f({ [`f_${attr.code}`]: "40-60" }),
      });
      expect(ranged.brands.map((x) => [x.name, x.count])).toEqual([
        ["Alfa", 1],
        ["Beta", 1],
      ]);
    });
  });

  it("intervalul numeric: limitele reale ale valorilor, calculate cu celelalte filtre dar fără propriul interval", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const attr = await numberAttribute(tx, `volum_${uid()}`.replace(/-/g, "_"));
      const a = await tx.brand.create({ data: { slug: `m-a-${uid()}`, name: "Alfa" } });
      const b = await tx.brand.create({ data: { slug: `m-b-${uid()}`, name: "Beta" } });
      for (const [brand, value] of [
        [a, 30],
        [a, 60],
        [b, 90],
      ] as const) {
        const p = await product(tx, { brandId: brand.id, categoryId: cat.id });
        await setNumber(tx, p.id, attr.id, value);
      }
      const base = { categoryPath: cat.path };
      const all = await reader.getFacets({ ...base, filters: EMPTY_FILTERS });
      expect(all.ranges.find((r) => r.code === attr.code)).toMatchObject({
        min: 30,
        max: 90,
        count: 3,
        unit: "mc/h",
      });

      // marca Alfa: limitele se strâng la 30–60
      const alfa = await reader.getFacets({ ...base, filters: f({ marca: a.slug }) });
      expect(alfa.ranges.find((r) => r.code === attr.code)).toMatchObject({
        min: 30,
        max: 60,
        count: 2,
      });

      // intervalul ales nu își strânge propriile limite (sliderul își păstrează capetele), iar valoarea aleasă e raportată
      const picked = await reader.getFacets({
        ...base,
        filters: f({ [`f_${attr.code}`]: "50-70" }),
      });
      expect(picked.ranges.find((r) => r.code === attr.code)).toMatchObject({
        min: 30,
        max: 90,
        selected: { min: 50, max: 70 },
      });
    });
  });

  it("un atribut fără valori în listă nu apare în panou", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const attr = await numberAttribute(tx, `gol_${uid()}`.replace(/-/g, "_"));
      await product(tx, { categoryId: cat.id });
      const facets = await reader.getFacets({ categoryPath: cat.path });
      expect(facets.ranges.some((r) => r.code === attr.code)).toBe(false);
    });
  });

  it("atribut de tip listă: opțiunile cu contorizări; filtrul pe opțiune (SAU) și chip-urile cu numele opțiunii", async () => {
    await withReader(async (reader, tx) => {
      const cat = await category(tx);
      const code = `material_${uid()}`.replace(/-/g, "_");
      const attr = await tx.attribute.create({
        data: { code, name: "Material", type: "select", isFilterable: true },
      });
      const inox = await tx.attributeOption.create({
        data: { attributeId: attr.id, value: "Inox", position: 0 },
      });
      const pvc = await tx.attributeOption.create({
        data: { attributeId: attr.id, value: "PVC", position: 1 },
      });
      const made = [] as string[];
      for (const option of [inox, inox, pvc]) {
        const p = await product(tx, { categoryId: cat.id });
        await tx.attributeValue.create({
          data: { productId: p.id, attributeId: attr.id, optionId: option.id },
        });
        made.push(p.id);
      }
      const facets = await reader.getFacets({ categoryPath: cat.path });
      expect(
        facets.options.find((o) => o.code === code)?.options.map((o) => [o.value, o.count]),
      ).toEqual([
        ["Inox", 2],
        ["PVC", 1],
      ]);
      const filters = f({ [`f_${code}`]: pvc.id });
      const result = await reader.listProducts({ categoryPath: cat.path, filters }, SORT, settings);
      expect(ids(result)).toEqual(new Set([made[2]]));
      const named = await reader.describeFilters(filters);
      expect(named.options[code]).toEqual({ [pvc.id]: "PVC" });
      // opțiunile se numără fără propriul filtru: după alegerea PVC, «Inox» rămâne cu 2
      const after = await reader.getFacets({ categoryPath: cat.path, filters });
      expect(
        after.options
          .find((o) => o.code === code)
          ?.options.map((o) => [o.value, o.count, o.selected]),
      ).toEqual([
        ["Inox", 2, false],
        ["PVC", 1, true],
      ]);
    });
  });
});

describe("căutare (FTS + trigrame)", () => {
  const find = async (reader: CatalogReader, q: string) =>
    reader.listProducts({ search: q }, { sort: "relevance", offset: 0, limit: 50 }, settings);

  it("găsește fără diacritice, cu prefix de cuvânt și cu mai multe cuvinte (ȘI); ciornele nu apar", async () => {
    await withReader(async (reader, tx) => {
      const tag = `zq${uid().replace(/-/g, "")}`;
      const heat = await product(tx, { title: `Pompă de căldură ${tag} inverter` });
      await product(tx, { title: `Filtru nisip ${tag}` });
      await product(tx, { title: `Pompă de căldură ${tag} ciornă`, status: "draft" });
      expect(ids(await find(reader, `pompa caldura ${tag}`))).toEqual(new Set([heat.id]));
      expect(ids(await find(reader, `pomp ${tag}`))).toEqual(new Set([heat.id]));
      expect((await find(reader, tag)).total).toBe(2);
    });
  });

  it("când textul se potrivește exact pe cuvinte, trigramele nu aduc produse fără legătură; fără nicio potrivire exactă, se acceptă greșeli de scriere", async () => {
    await withReader(async (reader, tx) => {
      const tag = uid().replace(/-/g, "");
      const alfa = await product(tx, { title: `Pompa alfa ${tag} mica` });
      await product(tx, { title: `Pompa beta ${tag} mare` });
      expect(ids(await find(reader, `pompa alfa ${tag}`))).toEqual(new Set([alfa.id]));
      // niciun produs nu are cuvântul «pompaa»: fuzzy aduce produsele cu titlu apropiat
      expect((await find(reader, `pompaa alfa ${tag}`)).total).toBeGreaterThan(0);
    });
  });

  it("greșeli de scriere apropiate (trigrame) și cod de produs / cod de producător, după început", async () => {
    await withReader(async (reader, tx) => {
      const tag = uid().replace(/-/g, "");
      const filter = await product(tx, { title: `Filtrul cuarțit ${tag}`, sku: `ASTR-${tag}-77` });
      await tx.productVariant.updateMany({
        where: { productId: filter.id },
        data: { manufacturerPartNumber: `MPN${tag}99` },
      });
      expect(ids(await find(reader, `ASTR-${tag}`))).toEqual(new Set([filter.id]));
      expect(ids(await find(reader, `mpn${tag}`))).toEqual(new Set([filter.id]));
      // «Filtrul cuartit» (literă lipsă): trigramele îl prind
      expect(ids(await find(reader, `Filtrul cuartit ${tag}`)).has(filter.id)).toBe(true);
    });
  });

  it("relevanța: codul exact e primul; o interogare prea scurtă sau fără cuvinte nu găsește nimic", async () => {
    await withReader(async (reader, tx) => {
      const tag = uid().replace(/-/g, "");
      const exact = await product(tx, { title: `Cot PVC alb`, sku: `ZZ${tag}` });
      await product(tx, { title: `Accesoriu cu cod ZZ${tag} în titlu` });
      const result = await find(reader, `zz${tag}`);
      expect(result.items[0]?.id).toBe(exact.id);
      expect((await find(reader, "a")).total).toBe(0);
      expect((await find(reader, "!!")).total).toBe(0);
    });
  });

  it("textul din interogare nu poate schimba structura SQL (caractere speciale)", async () => {
    await withReader(async (reader) => {
      for (const q of [`'; drop table product; --`, `a:* | !b`, `((`, `%_\\`, `ab\u0000cd`]) {
        await expect(find(reader, q)).resolves.toBeDefined();
      }
    });
  });

  it("sugestii: produse, categorii și mărci cu prefix", async () => {
    await withReader(async (reader, tx) => {
      const tag = uid().replace(/-/g, "");
      const brand = await tx.brand.create({ data: { slug: `mq-${tag}`, name: `Zebra${tag}` } });
      const catSlug = `zebracat${tag}`;
      const cat = await tx.category.create({
        data: { slug: catSlug, name: `Zebra cat ${tag}`, path: catSlug, depth: 0 },
      });
      const p = await product(tx, {
        title: `Zebra pompă ${tag}`,
        brandId: brand.id,
        categoryId: cat.id,
      });
      const out = await reader.suggest(`zebra`, 6, settings);
      expect(out.products.map((x) => x.id)).toContain(p.id);
      expect(out.categories.map((c) => c.path)).toContain(catSlug);
      expect(out.brands.map((b) => b.slug)).toContain(brand.slug);
      expect((await reader.suggest("z", 6, settings)).products).toEqual([]);
    });
  });
});

describe("liste: marcă și colecție", () => {
  it("pagina de marcă: doar produsele mărcii; pagina de colecție: doar produsele ei", async () => {
    await withReader(async (reader, tx) => {
      const brand = await tx.brand.create({ data: { slug: `mb-${uid()}`, name: "Marca X" } });
      const inBrand = await product(tx, { brandId: brand.id });
      await product(tx);
      const collection = await tx.collection.create({
        data: { slug: `col-${uid()}`, name: "Colecție" },
      });
      const inCollection = await product(tx);
      await tx.collectionProduct.create({
        data: { collectionId: collection.id, productId: inCollection.id },
      });
      expect(ids(await reader.listProducts({ brandSlug: brand.slug }, SORT, settings))).toEqual(
        new Set([inBrand.id]),
      );
      expect(
        ids(await reader.listProducts({ collectionId: collection.id }, SORT, settings)),
      ).toEqual(new Set([inCollection.id]));
    });
  });
});

describe("sursa pentru sitemap", () => {
  it("doar produsele active; categoriile și mărcile doar dacă au produse active", async () => {
    await withReader(async (reader, tx) => {
      const live = await category(tx);
      const empty = await category(tx);
      const draftOnly = await category(tx);
      const brand = await tx.brand.create({ data: { slug: `sm-${uid()}`, name: "Marca S" } });
      const emptyBrand = await tx.brand.create({
        data: { slug: `se-${uid()}`, name: "Marca goală" },
      });
      const ok = await product(tx, { categoryId: live.id, brandId: brand.id });
      const draft = await product(tx, { categoryId: draftOnly.id, status: "draft" });
      const source = await reader.listSitemapSource();
      const slugs = new Set(source.products.map((p) => p.slug));
      expect(slugs.has(ok.slug)).toBe(true);
      expect(slugs.has(draft.slug)).toBe(false);
      const paths = new Set(source.categories.map((c) => c.path));
      expect(paths.has(live.path)).toBe(true);
      expect(paths.has(empty.path)).toBe(false);
      expect(paths.has(draftOnly.path)).toBe(false);
      const brandSlugs = new Set(source.brands.map((b) => b.slug));
      expect(brandSlugs.has(brand.slug)).toBe(true);
      expect(brandSlugs.has(emptyBrand.slug)).toBe(false);
    });
  });
});

describe("pagina de produs: fișa explodată, documente, piese și compatibilitate", () => {
  it("fișa se încarcă doar cu includeDiagram (flag-ul); piesele, documentele și «Se montează cu» vin din relații și din tabul Descărcări", async () => {
    await withReader(async (reader, tx) => {
      const main = await product(tx);
      const part = await product(tx, { title: "Garnitură" });
      const other = await product(tx, { title: "Racord compatibil" });
      const media = await tx.media.create({
        data: {
          status: "ready",
          mime: "image/png",
          sizeBytes: 10,
          checksum: "c".repeat(64),
          originalName: "fisa.png",
          storageKey: `public/media/${uid()}/original.png`,
          variants: [],
        },
      });
      const diagram = await tx.partsDiagram.create({
        data: { title: "Fișa pompei", mediaId: media.id },
      });
      await tx.partsDiagramProduct.create({ data: { diagramId: diagram.id, productId: main.id } });
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 1, productId: part.id, xBp: 1000, yBp: 2000 },
      });
      await tx.productRelation.create({
        data: { productId: main.id, relatedProductId: part.id, type: "spare_part" },
      });
      await tx.productRelation.create({
        data: { productId: main.id, relatedProductId: other.id, type: "compatible_with" },
      });
      await tx.productDocument.create({
        data: {
          productId: main.id,
          type: "manual",
          title: "Manual",
          storageKey: `private/docs/${uid()}.pdf`,
          originalName: "manual.pdf",
          mime: "application/pdf",
          sizeBytes: 1234,
          showInTab: true,
        },
      });
      await tx.productDocument.create({
        data: {
          productId: main.id,
          type: "other",
          title: "Ascuns",
          storageKey: `private/docs/${uid()}.pdf`,
          originalName: "ascuns.pdf",
          mime: "application/pdf",
          sizeBytes: 1,
          showInTab: false,
        },
      });

      const off = await reader.getProduct(main.slug, settings);
      expect(off?.diagram).toBeNull();
      const on = await reader.getProduct(main.slug, settings, { includeDiagram: true });
      expect(on?.diagram?.parts).toHaveLength(1);
      expect(on?.diagram?.parts[0]).toMatchObject({
        number: 1,
        xBp: 1000,
        product: { title: "Garnitură" },
      });
      for (const page of [off, on]) {
        expect(page?.spareParts.map((p) => p.id)).toEqual([part.id]);
        expect(page?.compatible.map((p) => p.id)).toEqual([other.id]);
        expect(page?.documents.map((d) => d.title)).toEqual(["Manual"]);
      }
      // adresa fișierului nu intră în datele paginii
      expect(JSON.stringify(on)).not.toContain("private/docs");
    });
  });
});
