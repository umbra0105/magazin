import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { MediaInUseError, MediaLibraryService } from "../media/library";
import { createPrismaLibraryStore } from "../media/library-store";
import { createPrismaProcessingStore } from "../media/processing-store";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { BrandService, createPrismaBrandStore } from "./brand-service";
import { createPrismaCategoryStore } from "./category-store";
import { CategoryService } from "./category-service";
import { createMediaUsageRegistry } from "./media-usage";

const db = getDb();
let base: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-cat-brand-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "s"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    categories: CategoryService;
    brands: BrandService;
    library: MediaLibraryService;
    as: (role: string) => Promise<PermissionSubject>;
    media: () => Promise<{ id: string; key: string }>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const logger = createLogger({ destination: { write() {} } });
    const categories = new CategoryService({
      store: createPrismaCategoryStore(tx),
      audit,
      logger,
    });
    const brands = new BrandService({ store: createPrismaBrandStore(tx), audit, logger });
    const library = new MediaLibraryService({
      store: createPrismaLibraryStore(tx),
      storage,
      audit,
      usage: createMediaUsageRegistry(tx),
      processing: createPrismaProcessingStore(tx),
      queue: { enqueueProcess: async () => undefined },
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `cb-${role}-${n++}`, name: role, email: `cb-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subiect lipsă");
      return subject;
    };
    const media = async () => {
      const key = `public/media/cb-${uid()}/original.jpg`;
      await storage.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), {
        contentType: "image/jpeg",
      });
      const row = await tx.media.create({
        data: {
          mime: "image/jpeg",
          sizeBytes: 5,
          checksum: uid(),
          originalName: "poza.jpg",
          storageKey: key,
          status: "ready",
        },
      });
      return { id: row.id, key };
    };
    return fn({ tx, categories, brands, library, as, media });
  });
}

describe("categorii pe baza reală", () => {
  it("arbore: creare, mutare cu subarbore (căi unice), reordonare, ștergere", async () => {
    await withServices(async ({ tx, categories, as }) => {
      const manager = await as("manager");
      const piscine = await categories.create(manager, { name: "Piscine" });
      const pompe = await categories.create(manager, { name: "Pompe", parentId: piscine.id });
      const filtrare = await categories.create(manager, { name: "Filtrare", parentId: pompe.id });
      const accesorii = await categories.create(manager, { name: "Accesorii" });

      await categories.move(manager, pompe.id, { parentId: accesorii.id });
      const rows = await tx.category.findMany({
        where: { id: { in: [pompe.id, filtrare.id] } },
        orderBy: { depth: "asc" },
      });
      expect(rows.map((r) => [r.path, r.depth])).toEqual([
        ["accesorii/pompe", 1],
        ["accesorii/pompe/filtrare", 2],
      ]);

      // redenumirea adresei recalculează descendenții
      await categories.update(manager, pompe.id, { slug: "pompe-noi" });
      expect((await tx.category.findUniqueOrThrow({ where: { id: filtrare.id } })).path).toBe(
        "accesorii/pompe-noi/filtrare",
      );

      // ordine: accesorii înaintea piscinelor
      await categories.move(manager, accesorii.id, { parentId: null, index: 0 });
      const roots = await tx.category.findMany({
        where: { parentId: null, id: { in: [piscine.id, accesorii.id] } },
        orderBy: { sortOrder: "asc" },
      });
      expect(roots.map((r) => r.id)).toEqual([accesorii.id, piscine.id]);

      // ștergere: cea cu copii e refuzată, frunza se șterge
      await expect(categories.delete(manager, accesorii.id)).rejects.toMatchObject({
        code: "CATEGORY_HAS_CHILDREN",
      });
      await categories.delete(manager, filtrare.id);
      expect(await tx.category.count({ where: { id: filtrare.id } })).toBe(0);
    });
  });

  it("ștergerea unei categorii cu produse: mesaj cu numărul, nu eroare de bază; produsele șterse se numără separat", async () => {
    await withServices(async ({ tx, categories, as }) => {
      const owner = await as("owner");
      const cat = await categories.create(owner, { name: "Pompe" });
      const brand = await tx.brand.create({ data: { slug: `b-${uid()}`, name: "B" } });
      for (const deleted of [false, false, true]) {
        const p = await tx.product.create({
          data: {
            slug: `p-${uid()}`,
            title: "P",
            brandId: brand.id,
            ...(deleted && { deletedAt: new Date() }),
          },
        });
        await tx.productCategory.create({ data: { productId: p.id, categoryId: cat.id } });
      }
      const error = (await categories.delete(owner, cat.id).catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ code: "CATEGORY_HAS_PRODUCTS" });
      expect(error.message).toContain("2 produse");
      expect(error.message).toContain("1 produs șters");
      expect(await tx.category.count({ where: { id: cat.id } })).toBe(1);

      const listed = await categories.tree(owner);
      expect(listed.find((c) => c.id === cat.id)?.productCount).toBe(2);
    });
  });

  it("imaginea categoriei: fișierul nu se poate șterge din bibliotecă (categoria apare ca loc de folosire)", async () => {
    await withServices(async ({ tx, categories, library, as, media }) => {
      const manager = await as("manager");
      const owner = await as("owner");
      const m = await media();
      const cat = await categories.create(manager, { name: "Liner", imageMediaId: m.id });

      const error = (await library.delete(owner, m.id).catch((e: unknown) => e)) as MediaInUseError;
      expect(error).toBeInstanceOf(MediaInUseError);
      expect(error.usages).toEqual([
        {
          kind: "category",
          label: "Categorie: Liner",
          href: `/admin/produse/categorii?edit=${cat.id}`,
        },
      ]);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(1);
      expect(await storage.stat(m.key)).not.toBeNull();

      // după ce imaginea e scoasă din categorie, se poate șterge
      await categories.update(manager, cat.id, { imageMediaId: null });
      await library.delete(owner, m.id);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(0);
    });
  });
});

describe("branduri pe baza reală", () => {
  it("creare cu adresă unică, modificare de conținut de către Editor, interzis pentru adresă", async () => {
    await withServices(async ({ brands, as }) => {
      const manager = await as("manager");
      const editor = await as("editor");
      const b = await brands.create(manager, { name: "Hayward Pool" });
      expect(b.slug).toBe("hayward-pool");
      const second = await brands.create(manager, { name: "Hayward Pool" });
      expect(second.slug).toBe("hayward-pool-2");

      const updated = await brands.update(editor, b.id, {
        description: "Producător de echipamente",
      });
      expect(updated.description).toBe("Producător de echipamente");
      await expect(brands.update(editor, b.id, { slug: "alt-slug" })).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      await expect(
        brands.create(manager, { name: "Altul", slug: "HAYWARD-POOL".toLowerCase() }),
      ).rejects.toMatchObject({ code: "BRAND_SLUG_CONFLICT" });
    });
  });

  it("brandul cu produse nu se șterge (mesaj cu numărul); fără produse da", async () => {
    await withServices(async ({ tx, brands, as }) => {
      const owner = await as("owner");
      const b = await brands.create(owner, { name: "Cu produse" });
      await tx.product.create({ data: { slug: `p-${uid()}`, title: "P1", brandId: b.id } });
      await tx.product.create({ data: { slug: `p-${uid()}`, title: "P2", brandId: b.id } });
      const error = (await brands.delete(owner, b.id).catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ code: "BRAND_HAS_PRODUCTS" });
      expect(error.message).toContain("2 produse");

      const empty = await brands.create(owner, { name: "Gol" });
      await brands.delete(owner, empty.id);
      expect(await tx.brand.count({ where: { id: empty.id } })).toBe(0);
    });
  });

  it("logoul brandului: fișierul nu se șterge din bibliotecă; legacy doar pentru Admin/Owner", async () => {
    await withServices(async ({ brands, library, as, media }) => {
      const manager = await as("manager");
      const admin = await as("admin");
      const owner = await as("owner");
      const m = await media();
      const brand = await brands.create(manager, { name: "Logo SRL", logoMediaId: m.id });

      const error = (await library.delete(owner, m.id).catch((e: unknown) => e)) as MediaInUseError;
      expect(error.usages.map((u) => u.label)).toEqual(["Brand: Logo SRL"]);

      await expect(
        brands.update(manager, brand.id, { legacyId: "wc-brand-1" }),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      const withLegacy = await brands.update(admin, brand.id, {
        legacyId: "wc-brand-1",
        legacyUrl: "https://vechi.example/brand/logo",
      });
      expect(withLegacy.legacyId).toBe("wc-brand-1");
    });
  });
});
