import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { WOO_COST_SENTINEL, syntheticWooRows, wooCsv } from "../../../../test/woo-fixture";
import { AuditService } from "../../../audit/audit-service";
import { createPrismaAuditStore } from "../../../audit/prisma-store";
import { PermissionService } from "../../../rbac/permission-service";
import { runBaseSeed } from "../../../seed/base-seed";
import { settingGroups } from "../../../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../../../test-utils/rollback";
import { createProductImportService } from "../import-runtime";
import type { ImportAnalysis, ImportValidation } from "../import-service";

/**
 * Importul WooCommerce pe baza reală, cu fixture-ul SINTETIC: dry-run fără scrieri, aplicare exactă a ce s-a
 * verificat (categorii, branduri, atribute, produse simple și variabile, relații), un singur eveniment de
 * audit, idempotență (a doua rulare = «neschimbat»), starea păstrată la cerere, drepturi, cost nepătruns.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const logger = createLogger({ destination: { write() {} } });
const importDefaults = z.object(settingGroups.import).parse({});

function memoryStorage(): StorageDriver {
  const files = new Map<string, Buffer>();
  return {
    async put(key: string, body: Buffer) {
      files.set(key, body);
      return { key, size: body.length, contentType: "application/octet-stream" };
    },
    async get(key: string) {
      const body = files.get(key);
      if (!body) throw new Error("STORAGE_NOT_FOUND");
      return {
        stream: Readable.from([body]),
        object: { key, size: body.length, contentType: "application/octet-stream" },
      };
    },
    async delete(key: string) {
      files.delete(key);
    },
  } as unknown as StorageDriver;
}

type Subject = Awaited<ReturnType<PermissionService["loadSubject"]>>;

async function withWoo<T>(
  fn: (c: {
    tx: TestTx;
    service: ReturnType<typeof createProductImportService>;
    as: (role: string) => Promise<Subject>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const service = createProductImportService({
      db: tx as unknown as PrismaClient,
      storage: memoryStorage(),
      settings: {
        async getGroup(group: string) {
          if (group === "import") return importDefaults;
          if (group === "inventory") return { manageStock: true };
          if (group === "catalog") return { defaultWarrantyMonths: 24 };
          if (group === "regional") return { timezone: "Europe/Bucharest" };
          throw new Error(`grup neașteptat: ${group}`);
        },
        async getGroupUncached(group: string) {
          if (group === "imageImport") return z.object(settingGroups.imageImport).parse({});
          throw new Error(`grup neașteptat: ${group}`);
        },
      } as never,
      audit: new AuditService(createPrismaAuditStore(tx)),
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `woo-${role}-${n++}`, name: role, email: `woo-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, as });
  });
}

const file = (name = "woo.csv") => ({ bytes: wooCsv(syntheticWooRows()), fileName: name });

async function check(
  service: ReturnType<typeof createProductImportService>,
  subject: Subject,
  overrides: Record<string, unknown> = {},
): Promise<{ analysis: ImportAnalysis; validation: ImportValidation }> {
  const analysis = await service.register(subject, file());
  const validation = await service.validate(subject, {
    importId: analysis.importId,
    profile: "woocommerce",
    options: { ...(analysis.woo?.defaults as object), ...overrides },
  });
  return { analysis, validation };
}

describe("import WooCommerce pe baza reală", () => {
  it("fișierul se recunoaște ca WooCommerce; analiza arată tipurile, clasele de livrare, atributele și coloanele ignorate", async () => {
    await withWoo(async ({ service, as }) => {
      const owner = await as("owner");
      const analysis = await service.register(owner, file());
      expect(analysis.woo).not.toBeNull();
      const woo = analysis.woo as NonNullable<ImportAnalysis["woo"]>;
      expect(woo.rowTypes).toMatchObject({
        simple: 9,
        variable: 1,
        variation: 3,
        grouped: 1,
        external: 1,
      });
      expect(woo.units).toEqual({ weight: "kg", dimensions: "cm" });
      expect(woo.defaults).toMatchObject({
        keepStatus: false,
        weightUnit: "kg",
        dimensionUnit: "cm",
      });
      expect(woo.shippingClasses.map((c) => [c.name, c.suggested])).toEqual(
        expect.arrayContaining([
          ["Paletizat", "pallet"],
          ["Supradimensionat", "oversized"],
          ["Curier special", null],
        ]),
      );
      // «Putere» e opțiune de variație (apare pe variații), deci nu se listează ca atribut simplu
      expect(woo.attributes.map((a) => a.name)).toEqual(["Material"]);
      expect(woo.blockedColumns).toEqual(["Meta: _pret_intrare"]);
      expect(woo.ignoredColumns.some((c) => c.header === "Imagini")).toBe(false);
      expect(woo.images).toMatchObject({
        hasColumn: true,
        canImport: true,
        allowedHosts: [],
        onAllowedHosts: 0,
      });
      expect(woo.defaults.importImages).toBe(false);
      // un fișier generic nu e WooCommerce
      const generic = await service.register(owner, {
        bytes: new TextEncoder().encode("SKU;Titlu;Preț\r\nA;B;10\r\n"),
        fileName: "g.csv",
      });
      expect(generic.woo).toBeNull();
    });
  });

  it("dry-run: raport complet, NICIO scriere în catalog; categoriile, brandurile și atributele de creat sunt listate", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const before = {
        products: await tx.product.count(),
        categories: await tx.category.count(),
        brands: await tx.brand.count(),
        attributes: await tx.attribute.count(),
        relations: await tx.productRelation.count(),
      };
      const { validation } = await check(service, owner);
      expect(validation.report.counts).toMatchObject({ new: 7, skipped: 2, errors: 6, updated: 0 });
      expect(validation.report.woo).toMatchObject({
        categoriesToCreate: [
          "Accesorii",
          "Accesorii, diverse",
          "Filtrare",
          "Pompe",
          "Filtrare > Filtre cu nisip",
          "Pompe > Pompe de circulație",
        ],
        brandsToCreate: ["Marca Fixture A", "Marca Fixture B"],
        attributesToCreate: ["Material"],
        blockedColumns: ["Meta: _pret_intrare"],
      });
      expect(validation.report.woo?.stats).toMatchObject({
        categoriesToCreate: 6,
        variations: 2,
        skuFallbacks: 1,
        unknownShippingClasses: 1,
      });
      expect(await tx.product.count()).toBe(before.products);
      expect(await tx.category.count()).toBe(before.categories);
      expect(await tx.brand.count()).toBe(before.brands);
      expect(await tx.attribute.count()).toBe(before.attributes);
      expect(await tx.productRelation.count()).toBe(before.relations);
    });
  });

  it("aplicare: categorii cu ierarhie, branduri, atribut, produse simple și variabil, relații; un singur audit; apoi a doua rulare = neschimbat", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const { validation } = await check(service, owner);
      const applied = await service.apply(owner, {
        importId: validation.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      expect(applied.mode).toBe("sync");
      if (applied.mode !== "sync") throw new Error("așteptam sync");
      expect(applied.report.counts).toMatchObject({ new: 7, skipped: 2, errors: 6 });

      // categorii: ierarhie corectă, virgula din nume păstrată
      const pompe = await tx.category.findFirstOrThrow({
        where: { name: "Pompe", parentId: null },
      });
      const circulatie = await tx.category.findFirstOrThrow({
        where: { name: "Pompe de circulație" },
      });
      expect(circulatie.parentId).toBe(pompe.id);
      expect(await tx.category.count({ where: { name: "Accesorii, diverse" } })).toBe(1);
      // brandurile și atributul
      expect(
        await tx.brand.count({ where: { name: { in: ["Marca Fixture A", "Marca Fixture B"] } } }),
      ).toBe(2);
      const material = await tx.attribute.findFirstOrThrow({ where: { name: "Material" } });
      expect(material).toMatchObject({ type: "text", code: "material" });

      // produsul simplu complet
      const v101 = await tx.productVariant.findFirstOrThrow({
        where: { sku: "FIX-101" },
        include: { product: { include: { categories: true, brand: true } } },
      });
      expect(v101).toMatchObject({
        price: 129_950,
        salePrice: 109_900,
        ean: "5901234123457",
        weightGrams: 12_500,
        lengthMm: 405,
        widthMm: 300,
        heightMm: 250,
      });
      expect(v101.saleStartsAt?.toISOString()).toBe("2026-10-31T22:00:00.000Z");
      expect(v101.saleEndsAt?.toISOString()).toBe("2026-11-30T21:59:59.000Z");
      expect(v101.product).toMatchObject({
        status: "draft",
        shippingClass: "pallet",
        legacyId: "101",
        subtitle: "Silențioasă, clasa A",
      });
      expect(v101.product.brand?.name).toBe("Marca Fixture A");
      expect(v101.product.categories).toHaveLength(2);
      expect(v101.product.categories.find((c) => c.isPrimary)?.categoryId).toBe(circulatie.id);
      expect(v101.product.description).toContain("Putere: 0,75 kW");
      expect(v101.product.description).not.toMatch(/<\/?[a-z]/i);
      // Omnibus: un singur punct de istoric, la data importului, cu prețul efectiv (promoția e în viitor)
      const history = await tx.priceHistory.findMany({ where: { variantId: v101.id } });
      expect(history).toHaveLength(1);
      expect(history[0]?.price).toBe(129_950);

      // SKU numeric păstrat ca text; fără SKU → WC-103
      expect(await tx.productVariant.count({ where: { sku: "00123" } })).toBe(1);
      expect(await tx.productVariant.count({ where: { sku: "WC-103" } })).toBe(1);
      const noScript = await tx.productVariant.findFirstOrThrow({
        where: { sku: "WC-103" },
        include: { product: true },
      });
      expect(noScript.product.description).toBe("Text normal & sigur.\n\nFinal");

      // produsul variabil: opțiune, valori, variante cu alegerea lor, atribut simplu
      const variable = await tx.product.findFirstOrThrow({
        where: { legacyId: "200" },
        include: {
          options: { include: { values: { orderBy: { position: "asc" } } } },
          variants: { include: { optionValues: true }, orderBy: { position: "asc" } },
          attributes: true,
        },
      });
      expect(variable.options.map((o) => [o.name, o.values.map((v) => v.value)])).toEqual([
        ["Putere", ["0,5 kW", "0,75 kW"]],
      ]);
      expect(
        variable.variants.map((v) => [
          v.sku,
          v.price,
          v.weightGrams,
          v.legacyId,
          v.optionValues.length,
        ]),
      ).toEqual([
        ["FIX-VAR-05", 180_000, 7000, "201", 1],
        ["FIX-VAR-075", 210_000, 8250, "202", 1],
      ]);
      expect(variable.attributes).toHaveLength(1);
      expect(variable.attributes[0]).toMatchObject({
        attributeId: material.id,
        textValue: "Polipropilenă",
      });

      // relațiile din a doua trecere
      const p101 = v101.productId;
      const relations = await tx.productRelation.findMany({
        where: { productId: p101 },
        include: { relatedProduct: { include: { variants: true } } },
      });
      expect(relations.map((r) => [r.type, r.relatedProduct.variants[0]?.sku]).sort()).toEqual([
        ["crosssell", "FIX-104"],
        ["upsell", "WC-103"],
      ]);

      // evenimentul agregat al importului ȘI evenimentele pe entitate (Blocul C, C-12), cu importul ca origine
      expect(
        await tx.auditLog.count({
          where: { action: "product.import", entityId: validation.importId },
        }),
      ).toBe(1);
      const entityEvents = await tx.auditLog.findMany({
        where: {
          action: { in: ["product.create", "category.create", "brand.create"] },
          actorId: owner?.userId,
        },
      });
      expect(entityEvents.filter((e) => e.action === "category.create").length).toBeGreaterThan(0);
      expect(entityEvents.filter((e) => e.action === "product.create").length).toBeGreaterThan(0);
      for (const event of entityEvents) {
        expect(event.after).toMatchObject({ importId: validation.importId });
      }

      // a doua rulare: tot «neschimbat» (rândurile murdare rămân erori), nimic de aplicat
      const second = await check(service, owner);
      expect(second.validation.report.counts).toMatchObject({
        new: 0,
        updated: 0,
        unchanged: 7,
        skipped: 2,
        errors: 6,
      });
      expect(second.validation.report.woo?.categoriesToCreate).toEqual([]);
      expect(second.validation.report.woo?.brandsToCreate).toEqual([]);
      expect(second.validation.report.woo?.attributesToCreate).toEqual([]);
      await expect(
        service.apply(owner, {
          importId: second.validation.importId,
          confirm: true,
          expectedPlanHash: second.validation.planHash,
        }),
      ).rejects.toMatchObject({ code: "IMPORT_NOTHING_TO_APPLY" });
    });
  });

  it("«păstrează starea din fișier»: la o a doua rulare doar produsul publicat devine activ", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const first = await check(service, owner);
      await service.apply(owner, {
        importId: first.validation.importId,
        confirm: true,
        expectedPlanHash: first.validation.planHash,
      });
      const kept = await check(service, owner, { keepStatus: true });
      // publicate în fișier: toate cu «Publicat = 1», în afară de FIX-104; deci se activează cele noi 1/0
      expect(kept.validation.report.counts.updated).toBeGreaterThanOrEqual(3);
      const applied = await service.apply(owner, {
        importId: kept.validation.importId,
        confirm: true,
        expectedPlanHash: kept.validation.planHash,
      });
      expect(applied.mode).toBe("sync");
      const status = async (sku: string) =>
        (await tx.productVariant.findFirstOrThrow({ where: { sku }, include: { product: true } }))
          .product.status;
      expect(await status("FIX-101")).toBe("active");
      expect(await status("FIX-104")).toBe("draft");
      // activarea a pus garanția implicită (regula de activare a catalogului)
      const warranty = await tx.productVariant.findFirstOrThrow({ where: { sku: "FIX-101" } });
      expect(warranty.warrantyMonths).toBe(24);
    });
  });

  it("fără catalog.legacy.edit (Manager) ID-urile vechi nu se salvează, restul merge; Owner le salvează", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const { validation } = await check(service, manager);
      expect(validation.report.woo?.stats.legacyNotSaved).toBeGreaterThan(0);
      await service.apply(manager, {
        importId: validation.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      const product = await tx.productVariant.findFirstOrThrow({
        where: { sku: "FIX-101" },
        include: { product: true },
      });
      expect(product.product.legacyId).toBeNull();
      expect(product.price).toBe(129_950);
      // un Owner care reface importul completează ID-urile
      const owner = await as("owner");
      const again = await check(service, owner);
      expect(again.validation.report.counts.updated).toBeGreaterThan(0);
      await service.apply(owner, {
        importId: again.validation.importId,
        confirm: true,
        expectedPlanHash: again.validation.planHash,
      });
      const after = await tx.productVariant.findFirstOrThrow({
        where: { sku: "FIX-101" },
        include: { product: true },
      });
      expect(after.product.legacyId).toBe("101");
    });
  });

  it("drepturi: Editorul și Suportul nu pot verifica un import WooCommerce; planul e legat de hash", async () => {
    await withWoo(async ({ service, as }) => {
      const owner = await as("owner");
      const analysis = await service.register(owner, file());
      for (const role of ["editor", "support"]) {
        const subject = await as(role);
        await expect(
          service.validate(subject, {
            importId: analysis.importId,
            profile: "woocommerce",
            options: analysis.woo?.defaults,
          }),
        ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      }
      const validation = await service.validate(owner, {
        importId: analysis.importId,
        profile: "woocommerce",
        options: analysis.woo?.defaults,
      });
      await expect(
        service.apply(owner, {
          importId: validation.importId,
          confirm: true,
          expectedPlanHash: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "IMPORT_STALE" });
    });
  });

  it("opțiuni invalide se refuză (cheie necunoscută, unitate nesuportată)", async () => {
    await withWoo(async ({ service, as }) => {
      const owner = await as("owner");
      const analysis = await service.register(owner, file());
      const base = analysis.woo?.defaults as object;
      await expect(
        service.validate(owner, {
          importId: analysis.importId,
          profile: "woocommerce",
          options: { ...base, costColumn: "x" },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        service.validate(owner, {
          importId: analysis.importId,
          profile: "woocommerce",
          options: { ...base, weightUnit: "lbs" },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });
  });

  it("prețul de achiziție din fișier nu ajunge nicăieri: nici în baza de date, nici în raport, nici în audit", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const { validation } = await check(service, owner);
      await service.apply(owner, {
        importId: validation.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      expect(await tx.productVariant.count({ where: { costPrice: { not: null } } })).toBe(0);
      expect(JSON.stringify(validation.report)).not.toContain(WOO_COST_SENTINEL);
      const record = await tx.productImport.findUniqueOrThrow({
        where: { id: validation.importId },
      });
      expect(JSON.stringify(record)).not.toContain(WOO_COST_SENTINEL);
      const audits = await tx.auditLog.findMany({ where: { actorId: owner?.userId } });
      expect(JSON.stringify(audits)).not.toContain(WOO_COST_SENTINEL);
      const products = await tx.product.findMany({
        select: { title: true, description: true, subtitle: true },
      });
      expect(JSON.stringify(products)).not.toContain(WOO_COST_SENTINEL);
      void randomUUID;
    });
  });
});
