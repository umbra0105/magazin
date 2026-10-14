import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { ProductService } from "./product-service";
import { createPrismaProductStore } from "./product-store";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-14T12:00:00Z");

async function withService<T>(
  fn: (c: {
    tx: TestTx;
    service: ProductService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
    tags: string[][];
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const tags: string[][] = [];
    const service = new ProductService({
      store: createPrismaProductStore(tx),
      audit: new AuditService(createPrismaAuditStore(tx)),
      defaultManageStock: async () => true,
      invalidate: (t) => void tags.push([...t]),
      logger: createLogger({ destination: { write() {} } }),
      now: () => NOW,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `ps-${role}-${n++}`, name: role, email: `ps-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, as, tags });
  });
}

describe("ProductService pe baza reală", () => {
  it("creează produsul cu variante, istoric de preț și audit; rezultatul nu conține cost", async () => {
    await withService(async ({ tx, service, as, tags }) => {
      const sku = `PX-${uid()}`;
      const { product, variants } = await service.create(await as("manager"), {
        title: "Pompă de căldură 12 kW",
        variants: [{ sku, price: 450000, salePrice: 420000, ean: "5901234123457" }],
      });
      expect(product.slug).toBe("pompa-de-caldura-12-kw");
      expect(product.manageStock).toBe(true);
      expect(variants[0]).toMatchObject({ sku, price: 450000, isDefault: true });

      // niciun câmp de cost în ce iese din serviciu
      for (const record of [product, ...variants]) {
        expect("costPrice" in record).toBe(false);
        expect("costPriceDate" in record).toBe(false);
      }

      const history = await tx.priceHistory.findMany({ where: { variantId: variants[0]?.id } });
      expect(history).toEqual([expect.objectContaining({ price: 420000, effectiveFrom: NOW })]);
      const row = await tx.productVariant.findUniqueOrThrow({ where: { id: variants[0]?.id } });
      expect(row.costPrice).toBeNull();
      expect(row.costPriceDate).toBeNull();
      expect(await tx.costPriceHistory.count({ where: { variantId: row.id } })).toBe(0);

      const audit = await tx.auditLog.findMany({ where: { entityId: product.id } });
      expect(audit).toHaveLength(1);
      expect(tags[0]).toContain(`product:${product.id}`);
    });
  });

  it("adresa: sufix la coliziune; un produs șters își păstrează adresa; mesaj clar la conflict", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const first = await service.create(manager, {
        title: "Filtru nisip",
        variants: [{ sku: `F-${uid()}`, price: 1000 }],
      });
      expect(first.product.slug).toBe("filtru-nisip");

      await tx.product.update({
        where: { id: first.product.id },
        data: { deletedAt: new Date() },
      });

      // generarea sare peste adresa produsului șters
      const second = await service.create(manager, {
        title: "Filtru nisip",
        variants: [{ sku: `F-${uid()}`, price: 1000 }],
      });
      expect(second.product.slug).toBe("filtru-nisip-2");

      // adresa explicită a celui șters: refuz clar
      const error = (await service
        .create(manager, {
          title: "Altceva",
          slug: "FILTRU-NISIP".toLowerCase(),
          variants: [{ sku: `F-${uid()}`, price: 1000 }],
        })
        .catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ code: "CATALOG_SLUG_CONFLICT" });
      expect(error.message).toContain("produsul șters");
      expect(error.message).toContain("Filtru nisip");
    });
  });

  it("Editorul modifică conținutul (audit cu diferențe); câmpurile interzise sunt refuzate și auditate denied", async () => {
    await withService(async ({ tx, service, as }) => {
      const created = await service.create(await as("owner"), {
        title: "Liner",
        description: "vechi",
        variants: [{ sku: `L-${uid()}`, price: 5000 }],
      });
      const editor = await as("editor");
      const updated = await service.update(editor, created.product.id, {
        description: "nou",
        seoTitle: "Liner piscină",
      });
      expect(updated).toMatchObject({ description: "nou", seoTitle: "Liner piscină" });

      await expect(
        service.update(editor, created.product.id, { description: "x", status: "active" }),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

      const rows = await tx.auditLog.findMany({
        where: { entityId: created.product.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => [r.action, r.outcome])).toEqual([
        ["product.create", "success"],
        ["product.update", "success"],
        ["product.update", "denied"],
      ]);
      expect(JSON.stringify(rows[2])).not.toContain('"x"');
      const stored = await tx.product.findUniqueOrThrow({ where: { id: created.product.id } });
      expect(stored.status).toBe("draft");
      expect(stored.description).toBe("nou");
    });
  });

  it("varianta: prețul efectiv schimbat intră în istoric (Omnibus), costul rămâne neatins", async () => {
    await withService(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const created = await service.create(owner, {
        title: "Pompă",
        variants: [{ sku: `P-${uid()}`, price: 20000 }],
      });
      const variantId = created.variants[0]?.id as string;
      await tx.productVariant.update({
        where: { id: variantId },
        data: { costPrice: 12000, costPriceDate: new Date("2026-09-01") },
      });

      await service.updateVariant(owner, variantId, { price: 18000 });
      const history = await tx.priceHistory.findMany({
        where: { variantId },
        orderBy: { effectiveFrom: "asc" },
      });
      expect(history.map((h) => h.price)).toEqual([18000]); // upsert pe același moment (NOW)

      const row = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(row).toMatchObject({ price: 18000, costPrice: 12000 });
      const audit = await tx.auditLog.findMany({ where: { action: "product.variant.update" } });
      expect(JSON.stringify(audit)).not.toContain("12000");
    });
  });

  it("generează variantele: opțiuni, valori, legături compuse și istoric; a doua rulare nu duplică", async () => {
    await withService(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const base = `T-${uid()}`.toUpperCase();
      const created = await service.create(owner, {
        title: "Tricou",
        variants: [{ sku: base, price: 5000 }],
      });
      const productId = created.product.id;
      const options = [
        { name: "Mărime", values: ["S", "M"] },
        { name: "Culoare", values: ["Roșu", "Albastru"] },
      ];

      const first = await service.generateVariants(owner, productId, { options, price: 6000 });
      expect(first.created).toHaveLength(4);
      expect(first.created[0]?.sku).toBe(`${base}-S-ROSU`);
      expect(first.orphaned).toBe(0);

      const optionRows = await tx.productOption.findMany({
        where: { productId },
        include: { values: true },
        orderBy: { position: "asc" },
      });
      expect(optionRows.map((o) => [o.name, o.values.length])).toEqual([
        ["Mărime", 2],
        ["Culoare", 2],
      ]);
      // fiecare variantă generată are exact o valoare per opțiune
      const links = await tx.variantOptionValue.groupBy({
        by: ["variantId"],
        where: { productId },
        _count: true,
      });
      expect(links).toHaveLength(4);
      expect(links.every((l) => l._count === 2)).toBe(true);
      expect(
        await tx.priceHistory.count({
          where: { variantId: { in: first.created.map((v) => v.id) } },
        }),
      ).toBe(4);

      const again = await service.generateVariants(owner, productId, { options, price: 6000 });
      expect(again.created).toEqual([]);
      expect(again.existing).toBe(4);
      expect(await tx.productVariant.count({ where: { productId } })).toBe(5); // 1 implicită + 4
    });
  });
});
