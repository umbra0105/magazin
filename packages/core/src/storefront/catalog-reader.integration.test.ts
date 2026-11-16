import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { CatalogReader, type CatalogSettings } from "./catalog-reader";

const db = getDb();
afterAll(() => db.$disconnect());

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
});
const NOW = new Date("2030-06-15T12:00:00Z");
const DAY = 86_400_000;
const uid = (): string => randomUUID().slice(0, 8);

const settings = (over: Partial<CatalogSettings> = {}): CatalogSettings => ({
  showSalePricing: false,
  productsPerPage: 24,
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  ...over,
});

interface ProductFixture {
  title?: string;
  slug?: string;
  status?: string;
  deletedAt?: Date | null;
  price?: number;
  salePrice?: number | null;
  costPrice?: number | null;
  stockStatus?: "instock" | "outofstock" | "onbackorder";
  categoryId?: string;
  publishedAt?: Date | null;
  saleEndsAt?: Date;
}

async function makeProduct(tx: TestTx, f: ProductFixture = {}) {
  const slug = f.slug ?? `produs-${uid()}`;
  const product = await tx.product.create({
    data: {
      slug,
      title: f.title ?? `Produs ${slug}`,
      status: f.status ?? "active",
      deletedAt: f.deletedAt ?? null,
      manageStock: false,
      stockStatus: f.stockStatus ?? "instock",
      publishedAt: f.publishedAt ?? NOW,
      variants: {
        create: {
          sku: `SKU-${uid()}`,
          price: f.price ?? 10000,
          salePrice: f.salePrice ?? null,
          saleStartsAt: f.salePrice ? new Date(NOW.getTime() - DAY) : null,
          saleEndsAt: f.salePrice ? (f.saleEndsAt ?? new Date(NOW.getTime() + DAY)) : null,
          costPrice: f.costPrice ?? null,
          isDefault: true,
        },
      },
      ...(f.categoryId && {
        categories: { create: { categoryId: f.categoryId, isPrimary: true } },
      }),
    },
  });
  return product;
}

async function makeCategory(tx: TestTx, path: string, parentId: string | null = null) {
  const slug = path.split("/").pop() as string;
  return tx.category.create({
    data: { slug, name: slug, path, depth: path.split("/").length - 1, parentId },
  });
}

async function withReader<T>(fn: (reader: CatalogReader, tx: TestTx) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    return fn(new CatalogReader({ db: tx, storage, now: () => NOW }), tx);
  });
}

describe("CatalogReader: liste", () => {
  it("arată doar produsele active și nesterse; ciornele, arhivate și șterse nu apar", async () => {
    await withReader(async (reader, tx) => {
      const root = await makeCategory(tx, `cat-${uid()}`);
      const ok = await makeProduct(tx, { categoryId: root.id });
      await makeProduct(tx, { categoryId: root.id, status: "draft" });
      await makeProduct(tx, { categoryId: root.id, status: "archived" });
      await makeProduct(tx, { categoryId: root.id, deletedAt: NOW });
      const result = await reader.listProducts(
        { categoryPath: root.path },
        { sort: "recommended", offset: 0, limit: 24 },
        settings(),
      );
      expect(result.total).toBe(1);
      expect(result.items.map((i) => i.id)).toEqual([ok.id]);
    });
  });

  it("categoria cuprinde și subcategoriile, dar nu o categorie cu prefix asemănător", async () => {
    await withReader(async (reader, tx) => {
      const base = `pompe-${uid()}`;
      const parent = await makeCategory(tx, base);
      const child = await makeCategory(tx, `${base}/filtrare`, parent.id);
      const lookalike = await makeCategory(tx, `${base}-extra`);
      const inParent = await makeProduct(tx, { categoryId: parent.id });
      const inChild = await makeProduct(tx, { categoryId: child.id });
      await makeProduct(tx, { categoryId: lookalike.id });
      const result = await reader.listProducts(
        { categoryPath: base },
        { sort: "recommended", offset: 0, limit: 24 },
        settings(),
      );
      expect(new Set(result.items.map((i) => i.id))).toEqual(new Set([inParent.id, inChild.id]));
      expect(result.total).toBe(2);
    });
  });

  it("sortează după preț crescător și descrescător și paginează fără suprapuneri", async () => {
    await withReader(async (reader, tx) => {
      const cat = await makeCategory(tx, `c-${uid()}`);
      const prices = [30000, 10000, 20000, 40000, 50000];
      const created = [];
      for (const price of prices)
        created.push(await makeProduct(tx, { categoryId: cat.id, price }));
      const asc = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 0, limit: 24 },
        settings(),
      );
      expect(asc.items.map((i) => i.price?.amount)).toEqual([10000, 20000, 30000, 40000, 50000]);
      const desc = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_desc", offset: 0, limit: 24 },
        settings(),
      );
      expect(desc.items.map((i) => i.price?.amount)).toEqual([50000, 40000, 30000, 20000, 10000]);
      const page1 = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 0, limit: 2 },
        settings(),
      );
      const page2 = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 2, limit: 2 },
        settings(),
      );
      const page3 = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 4, limit: 2 },
        settings(),
      );
      expect([...page1.items, ...page2.items, ...page3.items].map((i) => i.price?.amount)).toEqual([
        10000, 20000, 30000, 40000, 50000,
      ]);
      expect(page1.total).toBe(5);
      expect(created).toHaveLength(5);
    });
  });

  it("promoția: cu reducerile oprite se sortează și se arată după prețul întreg; cu ele pornite, după cel redus", async () => {
    await withReader(async (reader, tx) => {
      const cat = await makeCategory(tx, `c-${uid()}`);
      const a = await makeProduct(tx, { categoryId: cat.id, price: 20000, salePrice: 5000 });
      const b = await makeProduct(tx, { categoryId: cat.id, price: 10000 });
      const off = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 0, limit: 24 },
        settings({ showSalePricing: false }),
      );
      expect(off.items.map((i) => i.id)).toEqual([b.id, a.id]);
      expect(off.items.map((i) => [i.price?.amount, i.price?.compareAt])).toEqual([
        [10000, null],
        [20000, null],
      ]);
      const on = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 0, limit: 24 },
        settings({ showSalePricing: true }),
      );
      expect(on.items.map((i) => i.id)).toEqual([a.id, b.id]);
      expect(on.items[0]?.price).toEqual({ amount: 5000, compareAt: 20000, isRange: false });
    });
  });

  it("promoție care se încheie exact acum: la sortare nu mai e redusă (sfârșitul e exclusiv)", async () => {
    await withReader(async (reader, tx) => {
      const cat = await makeCategory(tx, `c-${uid()}`);
      const ended = await makeProduct(tx, {
        categoryId: cat.id,
        price: 20000,
        salePrice: 5000,
        saleEndsAt: NOW,
      });
      const other = await makeProduct(tx, { categoryId: cat.id, price: 10000 });
      const result = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "price_asc", offset: 0, limit: 24 },
        settings({ showSalePricing: true }),
      );
      expect(result.items.map((i) => i.id)).toEqual([other.id, ended.id]);
    });
  });

  it("starea vizibilă a stocului vine din regulile de stoc: epuizat → indisponibil, la comandă → cu termen", async () => {
    await withReader(async (reader, tx) => {
      const cat = await makeCategory(tx, `c-${uid()}`);
      const out = await makeProduct(tx, { categoryId: cat.id, stockStatus: "outofstock" });
      const onOrder = await makeProduct(tx, { categoryId: cat.id, stockStatus: "onbackorder" });
      const inStock = await makeProduct(tx, { categoryId: cat.id });
      const result = await reader.listProducts(
        { categoryPath: cat.path },
        { sort: "name_asc", offset: 0, limit: 24 },
        settings(),
      );
      const state = (id: string) => result.items.find((i) => i.id === id)?.availability;
      expect(state(out.id)).toMatchObject({ state: "unavailable", purchasable: false });
      expect(state(onOrder.id)).toMatchObject({ state: "on_order", leadTimeDays: 14 });
      expect(state(inStock.id)).toMatchObject({ state: "in_stock", purchasable: true });
    });
  });
});

describe("CatalogReader: mărci", () => {
  it("doar mărcile cu produse active; cele cu mai multe produse întâi, cu numărul lor; limitate", async () => {
    await withReader(async (reader, tx) => {
      const tag = uid();
      const big = await tx.brand.create({ data: { slug: `b-big-${tag}`, name: `Zeta ${tag}` } });
      const small = await tx.brand.create({
        data: { slug: `b-small-${tag}`, name: `Alfa ${tag}` },
      });
      const empty = await tx.brand.create({ data: { slug: `b-empty-${tag}`, name: `Gol ${tag}` } });
      const draftOnly = await tx.brand.create({
        data: { slug: `b-draft-${tag}`, name: `Ciorna ${tag}` },
      });
      for (let i = 0; i < 2; i++) {
        const p = await makeProduct(tx);
        await tx.product.update({ where: { id: p.id }, data: { brandId: big.id } });
      }
      const one = await makeProduct(tx);
      await tx.product.update({ where: { id: one.id }, data: { brandId: small.id } });
      const draft = await makeProduct(tx, { status: "draft" });
      await tx.product.update({ where: { id: draft.id }, data: { brandId: draftOnly.id } });
      const all = await reader.listBrands(1000);
      const mine = all.filter((b) => [big, small, empty, draftOnly].some((x) => x.slug === b.slug));
      expect(mine.map((b) => [b.slug, b.productCount])).toEqual([
        [big.slug, 2],
        [small.slug, 1],
      ]);
      expect((await reader.listBrands(1)).length).toBe(1);
    });
  });
});

describe("CatalogReader: adrese și redirecționări", () => {
  it("produs: adresa exactă e ok; altă scriere (litere mari) și adresa veche duc la cea canonică; ciorna e inexistentă", async () => {
    await withReader(async (reader, tx) => {
      const slug = `pompa-${uid()}`;
      const product = await makeProduct(tx, { slug });
      expect(await reader.resolveProduct(slug)).toEqual({ kind: "ok", canonical: slug });
      expect(await reader.resolveProduct(slug.toUpperCase())).toEqual({
        kind: "redirect",
        canonical: slug,
      });
      await tx.slugRedirect.create({
        data: { kind: "product", oldKey: `${slug}-vechi`, targetId: product.id },
      });
      expect(await reader.resolveProduct(`${slug}-vechi`)).toEqual({
        kind: "redirect",
        canonical: slug,
      });
      expect(await reader.resolveProduct(`${slug}-necunoscut`)).toEqual({
        kind: "missing",
        canonical: null,
      });
      const draft = await makeProduct(tx, { status: "draft" });
      expect((await reader.resolveProduct(draft.slug)).kind).toBe("missing");
      const gone = await makeProduct(tx, { deletedAt: NOW });
      expect((await reader.resolveProduct(gone.slug)).kind).toBe("missing");
    });
  });

  it("o redirecționare spre un produs care nu mai e activ nu duce nicăieri (404, nu redirecționare în gol)", async () => {
    await withReader(async (reader, tx) => {
      const product = await makeProduct(tx, { status: "archived" });
      const old = `vechi-${uid()}`;
      await tx.slugRedirect.create({
        data: { kind: "product", oldKey: old, targetId: product.id },
      });
      expect((await reader.resolveProduct(old)).kind).toBe("missing");
    });
  });

  it("categorie: calea veche duce la calea curentă", async () => {
    await withReader(async (reader, tx) => {
      const path = `noua-${uid()}`;
      const category = await makeCategory(tx, path);
      await tx.slugRedirect.create({
        data: { kind: "category", oldKey: `${path}-veche`, targetId: category.id },
      });
      expect(await reader.resolveCategory(path)).toEqual({ kind: "ok", canonical: path });
      expect(await reader.resolveCategory(`${path}-veche`)).toEqual({
        kind: "redirect",
        canonical: path,
      });
      expect((await reader.resolveCategory("nu-exista")).kind).toBe("missing");
    });
  });
});

describe("CatalogReader: pagina de produs", () => {
  it("niciun câmp de cost nu ajunge în datele publice", async () => {
    await withReader(async (reader, tx) => {
      const product = await makeProduct(tx, { price: 12300, costPrice: 7771 });
      const page = await reader.getProduct(product.slug, settings());
      expect(page).not.toBeNull();
      const json = JSON.stringify(page);
      expect(json).not.toMatch(/cost/i);
      expect(json).not.toContain("7771");
      const listed = await reader.listedByIds([product.id], settings());
      expect(JSON.stringify(listed)).not.toMatch(/cost|7771/i);
    });
  });

  it("produsele asociate: un produs asociat care nu e activ nu apare", async () => {
    await withReader(async (reader, tx) => {
      const main = await makeProduct(tx);
      const live = await makeProduct(tx);
      const draft = await makeProduct(tx, { status: "draft" });
      for (const other of [live, draft]) {
        await tx.productRelation.create({
          data: { productId: main.id, relatedProductId: other.id, type: "accessory" },
        });
      }
      const page = await reader.getProduct(main.slug, settings());
      expect(page?.related.map((r) => r.id)).toEqual([live.id]);
    });
  });

  it("un produs inactiv sau șters nu are pagină", async () => {
    await withReader(async (reader, tx) => {
      const draft = await makeProduct(tx, { status: "draft" });
      const gone = await makeProduct(tx, { deletedAt: NOW });
      expect(await reader.getProduct(draft.slug, settings())).toBeNull();
      expect(await reader.getProduct(gone.slug, settings())).toBeNull();
    });
  });

  it("variantele poartă prețul afișat (cu reducerile oprite: prețul întreg) și starea stocului", async () => {
    await withReader(async (reader, tx) => {
      const product = await makeProduct(tx, { price: 20000, salePrice: 15000 });
      const off = await reader.getProduct(product.slug, settings({ showSalePricing: false }));
      expect(off?.variants[0]?.price).toEqual({ amount: 20000, compareAt: null });
      const on = await reader.getProduct(product.slug, settings({ showSalePricing: true }));
      expect(on?.variants[0]?.price).toEqual({ amount: 15000, compareAt: 20000 });
      expect(on?.variants[0]?.availability.state).toBe("in_stock");
    });
  });
});
