import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import type { StorageDriver } from "@ecom/integrations";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  ProductAssignmentsService,
  createPrismaProductAssignmentStore,
} from "./product-assignments";
import { ProductService } from "./product-service";
import { createPrismaProductStore } from "./product-store";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const storage = { publicUrl: (key: string) => `/media/${key}` } as unknown as StorageDriver;

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    products: ProductService;
    assignments: ProductAssignmentsService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const logger = createLogger({ destination: { write() {} } });
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => true,
      defaultWarrantyMonths: async () => 24,
      logger,
    });
    const assignments = new ProductAssignmentsService({
      store: createPrismaProductAssignmentStore(tx),
      audit,
      storage,
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `pa-${role}-${n++}`, name: role, email: `pa-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, products, assignments, as });
  });
}

const category = (tx: TestTx, name: string) =>
  tx.category.create({
    data: { name, slug: `${name}-${uid()}`, path: `${name}-${uid()}`, depth: 0 },
  });

const media = (tx: TestTx, status = "ready") =>
  tx.media.create({
    data: {
      mime: "image/jpeg",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "poza.jpg",
      storageKey: `public/media/${uid()}/original.jpg`,
      status,
      variants: [
        {
          name: "thumb",
          format: "webp",
          mime: "image/webp",
          width: 320,
          height: 240,
          key: `public/media/${uid()}/thumb.webp`,
        },
      ],
    },
  });

describe("categorii și imagini pe produs, pe baza reală", () => {
  it("creare cu categorii în aceeași tranzacție: prima e principală; înlocuire; o singură principală", async () => {
    await withServices(async ({ tx, products, assignments, as }) => {
      const manager = await as("manager");
      const a = await category(tx, "a");
      const b = await category(tx, "b");
      const { product } = await products.create(manager, {
        title: `Cu categorii ${uid()}`,
        categoryIds: [a.id, b.id],
        variants: [{ sku: `PA-${uid()}`, price: 1000 }],
      });
      const created = await assignments.getCategories(manager, product.id);
      expect(created.find((c) => c.isPrimary)?.categoryId).toBe(a.id);
      expect(created).toHaveLength(2);

      await assignments.setCategories(manager, product.id, {
        categoryIds: [a.id, b.id],
        primaryId: b.id,
      });
      const swapped = await assignments.getCategories(manager, product.id);
      expect(swapped.filter((c) => c.isPrimary).map((c) => c.categoryId)).toEqual([b.id]);

      await assignments.setCategories(manager, product.id, { categoryIds: [] });
      expect(await assignments.getCategories(manager, product.id)).toEqual([]);
    });
  });

  it("la creare, o categorie inexistentă refuză tot (niciun produs rămas)", async () => {
    await withServices(async ({ tx, products, as }) => {
      const manager = await as("manager");
      const before = await tx.product.count();
      await expect(
        products.create(manager, {
          title: `Fără categorie ${uid()}`,
          categoryIds: ["inexistenta"],
          variants: [{ sku: `PA-${uid()}`, price: 1000 }],
        }),
      ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
      expect(await tx.product.count()).toBe(before);
    });
  });

  it("media: ordinea se păstrează, legăturile variantelor rămân, doar fișiere ready", async () => {
    await withServices(async ({ tx, products, assignments, as }) => {
      const editor = await as("editor");
      const manager = await as("manager");
      const m1 = await media(tx);
      const m2 = await media(tx);
      const pending = await media(tx, "pending");
      const { product, variants } = await products.create(manager, {
        title: `Cu poze ${uid()}`,
        variants: [{ sku: `PA-${uid()}`, price: 1000 }],
      });
      // o legătură la nivel de variantă, care nu trebuie atinsă de tabul Media al produsului
      await tx.productMedia.create({
        data: {
          productId: product.id,
          variantId: (variants[0] as { id: string }).id,
          mediaId: m1.id,
          position: 0,
        },
      });

      await assignments.setMedia(editor, product.id, { mediaIds: [m2.id, m1.id] });
      const listed = await assignments.listMedia(editor, product.id);
      expect(listed.map((i) => i.mediaId)).toEqual([m2.id, m1.id]);
      expect(listed[0]?.thumb).toMatch(/^\/media\/public\/media\/.+\/thumb\.webp$/);
      expect(
        await tx.productMedia.count({
          where: { productId: product.id, variantId: { not: null } },
        }),
      ).toBe(1);

      await expect(
        assignments.setMedia(editor, product.id, { mediaIds: [m1.id, pending.id] }),
      ).rejects.toMatchObject({ code: "CATALOG_MEDIA_INVALID" });
      // nimic nu s-a schimbat
      expect((await assignments.listMedia(editor, product.id)).map((i) => i.mediaId)).toEqual([
        m2.id,
        m1.id,
      ]);
    });
  });

  it("Editorul nu poate schimba categoriile (403) dar poate schimba imaginile; auditul are doar id-uri", async () => {
    await withServices(async ({ tx, products, assignments, as }) => {
      const editor = await as("editor");
      const manager = await as("manager");
      const a = await category(tx, "c");
      const m1 = await media(tx);
      const { product } = await products.create(manager, {
        title: `Drepturi ${uid()}`,
        variants: [{ sku: `PA-${uid()}`, price: 1000 }],
      });
      await expect(
        assignments.setCategories(editor, product.id, { categoryIds: [a.id] }),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      await assignments.setMedia(editor, product.id, { mediaIds: [m1.id] });

      const rows = await tx.auditLog.findMany({
        where: { entityId: product.id, action: { startsWith: "product." } },
        orderBy: { createdAt: "asc" },
      });
      const actions = rows.map((r) => `${r.action}:${r.outcome}`);
      expect(actions).toContain("product.update:denied");
      expect(actions).toContain("product.media.update:success");
      expect(JSON.stringify(rows).toLowerCase()).not.toContain("cost");
    });
  });
});
