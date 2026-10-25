import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { runBaseSeed } from "../seed/base-seed";
import { PermissionService } from "../rbac/permission-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createPrismaProductListStore, ProductListService } from "./product-list";

const db = getDb();
let base: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-list-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "s"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 4).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function withList<T>(
  fn: (c: {
    tx: TestTx;
    service: ProductListService;
    owner: Awaited<ReturnType<PermissionService["loadSubject"]>>;
    tag: string;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const user = await tx.user.create({
      data: { id: `pl-${uid()}`, name: "Owner", email: `pl-${uid()}@test.invalid` },
    });
    const role = await tx.role.findUniqueOrThrow({ where: { key: "owner" } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const owner = await new PermissionService(tx).loadSubject(user.id);
    const service = new ProductListService({
      store: createPrismaProductListStore(tx),
      storage,
    });
    return fn({ tx, service, owner, tag: uid() });
  });
}

const product = (tx: TestTx, tag: string, title: string, over: Record<string, unknown> = {}) =>
  tx.product.create({ data: { slug: `${tag}-${uid()}`, title: `${tag} ${title}`, ...over } });

describe("lista de produse pe baza reală", () => {
  it("caută după titlu, SKU, EAN (prefix) și cod producător; filtrează după stare, livrare, stoc, brand", async () => {
    await withList(async ({ tx, service, owner, tag }) => {
      const brand = await tx.brand.create({ data: { slug: `b-${tag}`, name: `Brand ${tag}` } });
      const a = await product(tx, tag, "Pompă de căldură", { status: "active", brandId: brand.id });
      await tx.productVariant.create({
        data: {
          productId: a.id,
          sku: `PC-${tag}`.toUpperCase(),
          price: 450000,
          ean: "5901234123457",
          manufacturerPartNumber: `SP-1400-${tag}`,
        },
      });
      const b = await product(tx, tag, "Filtru nisip", {
        status: "draft",
        shippingClass: "pallet",
        stockStatus: "outofstock",
      });
      await tx.productVariant.create({
        data: { productId: b.id, sku: `FN-${tag}`.toUpperCase(), price: 120000 },
      });

      const run = async (params: Record<string, string>) =>
        (await service.list(owner, { q: tag, ...params })).page.rows.map((r) => r.id).sort();

      expect(await run({})).toEqual([a.id, b.id].sort());
      expect(await run({ q: `${tag} Pompă` })).toEqual([a.id]);
      expect(await run({ q: `PC-${tag}` })).toEqual([a.id]); // SKU
      expect(await run({ q: "5901234123" })).toContain(a.id); // EAN (prefix)
      expect(await run({ q: `sp-1400-${tag}` })).toEqual([a.id]); // cod producător
      expect(await run({ status: "active" })).toEqual([a.id]);
      expect(await run({ shipping: "pallet" })).toEqual([b.id]);
      expect(await run({ stock: "outofstock" })).toEqual([b.id]);
      expect(await run({ brand: brand.id })).toEqual([a.id]);
      expect(await run({ status: "archived" })).toEqual([]);
    });
  });

  it("filtrul de categorie include subcategoriile; produsele șterse nu apar", async () => {
    await withList(async ({ tx, service, owner, tag }) => {
      const root = await tx.category.create({
        data: { slug: `r-${tag}`, name: "Rădăcină", path: `r-${tag}` },
      });
      const child = await tx.category.create({
        data: {
          slug: `c-${tag}`,
          name: "Copil",
          path: `r-${tag}/c-${tag}`,
          parentId: root.id,
          depth: 1,
        },
      });
      const other = await tx.category.create({
        data: { slug: `o-${tag}`, name: "Altă", path: `o-${tag}` },
      });
      const inChild = await product(tx, tag, "În copil");
      const inRoot = await product(tx, tag, "În rădăcină");
      const inOther = await product(tx, tag, "În alta");
      const deleted = await product(tx, tag, "Șters", { deletedAt: new Date() });
      for (const [p, c] of [
        [inChild, child],
        [inRoot, root],
        [inOther, other],
        [deleted, child],
      ] as const) {
        await tx.productCategory.create({ data: { productId: p.id, categoryId: c.id } });
      }

      const ids = async (category: string) =>
        (await service.list(owner, { q: tag, category })).page.rows.map((r) => r.id).sort();
      expect(await ids(root.id)).toEqual([inChild.id, inRoot.id].sort());
      expect(await ids(child.id)).toEqual([inChild.id]);
      expect(await ids(other.id)).toEqual([inOther.id]);
      expect(await ids("inexistent")).toEqual([]);
      const all = await service.list(owner, { q: tag });
      expect(all.page.rows.map((r) => r.id)).not.toContain(deleted.id);
    });
  });

  it("paginare pe server, sortare, interval de preț și număr de variante; fără câmpuri de cost în rânduri", async () => {
    await withList(async ({ tx, service, owner, tag }) => {
      for (let i = 0; i < 7; i++) {
        const p = await product(tx, tag, `Produs ${String(i).padStart(2, "0")}`);
        await tx.productVariant.create({
          data: {
            productId: p.id,
            sku: `S${i}-${tag}`,
            price: 1000 + i,
            costPrice: 500,
            costPriceDate: new Date("2026-09-01"),
          },
        });
        if (i === 0) {
          await tx.productVariant.create({
            data: { productId: p.id, sku: `S${i}b-${tag}`, price: 3000, position: 1 },
          });
        }
      }
      const page1 = await service.list(owner, { q: tag, size: "25", sort: "title_asc" });
      expect(page1.page).toMatchObject({ total: 7, page: 1, pageCount: 1 });
      expect(page1.page.rows.map((r) => r.title)).toEqual(
        Array.from({ length: 7 }, (_, i) => `${tag} Produs ${String(i).padStart(2, "0")}`),
      );
      const first = page1.page.rows[0];
      expect(first).toMatchObject({ variantCount: 2, priceMin: 1000, priceMax: 3000 });
      expect(page1.page.rows[1]).toMatchObject({
        variantCount: 1,
        singleVariantId: expect.any(String),
      });

      // niciun câmp de cost nu iese din listă, nici cu un cost setat pe variante
      for (const row of page1.page.rows) {
        expect(JSON.stringify(row).toLowerCase()).not.toContain("cost");
      }

      const desc = await service.list(owner, { q: tag, sort: "title_desc" });
      expect(desc.page.rows[0]?.title).toBe(`${tag} Produs 06`);
    });
  });

  it("configurarea de vânzare din rând: unitatea, baza, pasul și denumirea lui (efective la o variantă, ale produsului la mai multe)", async () => {
    await withList(async ({ tx, service, owner, tag }) => {
      const mp = await tx.measureUnit.create({
        data: { code: `mp_${tag}`, name: "Metru pătrat", symbol: "mp", decimals: 2 },
      });
      const kg = await tx.measureUnit.create({
        data: { code: `kg_${tag}`, name: "Kilogram", symbol: "kg", decimals: 3 },
      });
      // 1) produs la bucată, fără nimic setat
      const plain = await product(tx, tag, "Simplu");
      await tx.productVariant.create({
        data: { productId: plain.id, sku: `P1-${tag}`, price: 1000 },
      });
      // 2) liner: unitate și pas pe produs, cu denumire și «arată prețul pasului»
      const liner = await product(tx, tag, "Liner", {
        measureUnitId: mp.id,
        saleStep: 412_500,
        saleStepLabel: "rolă",
        showStepPrice: true,
      });
      await tx.productVariant.create({
        data: { productId: liner.id, sku: `P2-${tag}`, price: 8735 },
      });
      // 3) o singură variantă cu suprascriere proprie (kg, pe pas): rândul arată valorile EFECTIVE ale variantei
      const sac = await product(tx, tag, "Sac", { measureUnitId: mp.id, saleStep: 20_000 });
      await tx.productVariant.create({
        data: {
          productId: sac.id,
          sku: `P3-${tag}`,
          price: 12000,
          measureUnitId: kg.id,
          priceBasis: "step",
          saleStep: 250_000,
        },
      });
      // 4) mai multe variante: valorile produsului (variantele pot diferi între ele)
      const multi = await product(tx, tag, "Multi", {
        measureUnitId: kg.id,
        priceBasis: "step",
        saleStep: 250_000,
      });
      await tx.productVariant.create({
        data: { productId: multi.id, sku: `P4a-${tag}`, price: 12000 },
      });
      await tx.productVariant.create({
        data: {
          productId: multi.id,
          sku: `P4b-${tag}`,
          price: 13000,
          position: 1,
          saleStep: 500_000,
        },
      });

      const rows = (await service.list(owner, { q: tag, size: "25", sort: "title_asc" })).page.rows;
      const byTitle = (name: string) => rows.find((r) => r.title === `${tag} ${name}`);
      expect(byTitle("Simplu")?.sale).toEqual({
        unitSymbol: null,
        priceBasis: "unit",
        saleStep: null,
        saleStepLabel: null,
        showStepPrice: false,
      });
      expect(byTitle("Liner")?.sale).toEqual({
        unitSymbol: "mp",
        priceBasis: "unit",
        saleStep: 412_500,
        saleStepLabel: "rolă",
        showStepPrice: true,
      });
      expect(byTitle("Sac")?.sale).toEqual({
        unitSymbol: "kg",
        priceBasis: "step",
        saleStep: 250_000,
        saleStepLabel: null,
        showStepPrice: false,
      });
      expect(byTitle("Multi")?.sale).toEqual({
        unitSymbol: "kg",
        priceBasis: "step",
        saleStep: 250_000,
        saleStepLabel: null,
        showStepPrice: false,
      });
    });
  });

  it("doar thumb (nu originalul) și doar pentru fișierele gata; fără imagine: null", async () => {
    await withList(async ({ tx, service, owner, tag }) => {
      const variants = [
        {
          name: "thumb",
          format: "webp",
          mime: "image/webp",
          key: `public/media/${tag}/thumb.aa11.webp`,
          width: 320,
          height: 180,
          sizeBytes: 10,
        },
        {
          name: "large",
          format: "webp",
          mime: "image/webp",
          key: `public/media/${tag}/large.bb22.webp`,
          width: 1600,
          height: 900,
          sizeBytes: 10,
        },
      ];
      const ready = await tx.media.create({
        data: {
          mime: "image/png",
          sizeBytes: 5,
          checksum: tag,
          originalName: "a.png",
          storageKey: `public/media/${tag}/original.png`,
          status: "ready",
          variants,
        },
      });
      const pending = await tx.media.create({
        data: {
          mime: "image/png",
          sizeBytes: 5,
          checksum: `${tag}p`,
          originalName: "b.png",
          storageKey: `public/media/${tag}p/original.png`,
          status: "pending",
        },
      });
      const withImage = await product(tx, tag, "Cu imagine");
      const withPending = await product(tx, tag, "Cu imagine în procesare");
      const without = await product(tx, tag, "Fără imagine");
      await tx.productMedia.create({ data: { productId: withImage.id, mediaId: ready.id } });
      await tx.productMedia.create({ data: { productId: withPending.id, mediaId: pending.id } });

      const rows = (await service.list(owner, { q: tag })).page.rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const thumb = byId.get(withImage.id)?.thumb;
      expect(thumb).toMatch(/thumb\.aa11\.webp$/);
      expect(thumb).not.toContain("original");
      expect(thumb).not.toContain("large");
      expect(byId.get(withPending.id)?.thumb).toBeNull();
      expect(byId.get(without.id)?.thumb).toBeNull();
    });
  });

  it("cere products.read", async () => {
    await withList(async ({ service, tx, tag }) => {
      const user = await tx.user.create({
        data: { id: `pl-w-${uid()}`, name: "Depozit", email: `plw-${uid()}@test.invalid` },
      });
      const role = await tx.role.findUniqueOrThrow({ where: { key: "support" } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const support = await new PermissionService(tx).loadSubject(user.id);
      await expect(service.list(support, { q: tag })).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      await expect(service.list(null, {})).rejects.toBeDefined();
    });
  });
});
