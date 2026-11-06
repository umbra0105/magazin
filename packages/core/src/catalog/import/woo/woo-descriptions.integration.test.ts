import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { syntheticWooRows, wooCsv, type WooFixtureRow } from "../../../../test/woo-fixture";
import { AuditService } from "../../../audit/audit-service";
import { createPrismaAuditStore } from "../../../audit/prisma-store";
import { PermissionService } from "../../../rbac/permission-service";
import { runBaseSeed } from "../../../seed/base-seed";
import { settingGroups } from "../../../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../../../test-utils/rollback";
import { ProductService } from "../../product-service";
import { createPrismaProductStore } from "../../product-store";
import { createProductImportService } from "../import-runtime";
import type { ImportAnalysis, ImportValidation } from "../import-service";

/**
 * Reimportul «doar descrieri» al profilului WooCommerce (15c, pasul 8) pe baza reală, cu fixture-ul SINTETIC: dry-run fără
 * scrieri, aplicare care schimbă DOAR descrierea, descrierile editate manual păstrate (cu suprascriere la cerere), produse
 * inexistente ignorate (niciodată create), idempotență și evenimentele de audit marcate cu importul.
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
type Service = ReturnType<typeof createProductImportService>;

async function withWoo<T>(
  fn: (c: {
    tx: TestTx;
    service: Service;
    products: ProductService;
    as: (role: string) => Promise<Subject>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
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
      audit,
      logger,
    });
    // serviciul prin care „un om” editează descrierea din admin: audit obișnuit, FĂRĂ marcajul unui import
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => true,
      invalidate: () => undefined,
      logger,
      now: () => new Date(),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `wd-${role}-${n++}`, name: role, email: `wd-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, products, as });
  });
}

// ceasul real: serviciul de produse compară promoția cu el, deci datele fixture-ului pleacă din ora de la rulare
const fileOf = (rows: WooFixtureRow[] = syntheticWooRows(new Date()), name = "woo.csv") => ({
  bytes: wooCsv(rows),
  fileName: name,
});

async function validate(
  service: Service,
  subject: Subject,
  overrides: Record<string, unknown> = {},
  rows?: WooFixtureRow[],
): Promise<{ analysis: ImportAnalysis; validation: ImportValidation }> {
  const analysis = await service.register(subject, fileOf(rows));
  const validation = await service.validate(subject, {
    importId: analysis.importId,
    profile: "woocommerce",
    options: { ...(analysis.woo?.defaults as object), ...overrides },
  });
  return { analysis, validation };
}

async function apply(service: Service, subject: Subject, validation: ImportValidation) {
  const applied = await service.apply(subject, {
    importId: validation.importId,
    confirm: true,
    expectedPlanHash: validation.planHash,
  });
  if (applied.mode !== "sync") throw new Error("așteptam sync");
  return applied.report;
}

/** Importul obișnuit al fixture-ului: produsele FIX-* există apoi în baza de test. */
async function fullImport(service: Service, owner: Subject): Promise<void> {
  const { validation } = await validate(service, owner, { mode: "full" });
  await apply(service, owner, validation);
}

const descriptionOf = async (tx: TestTx, sku: string): Promise<string | null> =>
  (await tx.productVariant.findFirstOrThrow({ where: { sku }, include: { product: true } })).product
    .description;

const productIdOf = async (tx: TestTx, sku: string): Promise<string> =>
  (await tx.productVariant.findFirstOrThrow({ where: { sku } })).productId;

const ONLY = { mode: "descriptionsOnly" } as const;

describe("reimport «doar descrieri» pe baza reală", () => {
  it("produse inexistente: nimic nu se creează; dry-run și aplicare le ignoră cu motiv", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const before = {
        products: await tx.product.count(),
        categories: await tx.category.count(),
        brands: await tx.brand.count(),
        attributes: await tx.attribute.count(),
        audit: await tx.auditLog.count({ where: { entity: "product" } }),
      };
      const { validation } = await validate(service, owner, ONLY);
      expect(validation.report.counts).toMatchObject({ new: 0, updated: 0, errors: 0 });
      expect(validation.report.counts.skipped).toBeGreaterThan(5);
      expect(validation.report.woo?.stats.productsNotFound).toBeGreaterThan(5);
      expect(validation.report.woo?.categoriesToCreate).toEqual([]);
      expect(validation.report.woo?.brandsToCreate).toEqual([]);
      expect(validation.report.woo?.attributesToCreate).toEqual([]);

      // nimic de aplicat: serviciul refuză aplicarea, deci nu se creează nimic nici măcar din greșeală
      await expect(apply(service, owner, validation)).rejects.toMatchObject({
        code: "IMPORT_NOTHING_TO_APPLY",
      });
      expect(await tx.product.count()).toBe(before.products);
      expect(await tx.category.count()).toBe(before.categories);
      expect(await tx.brand.count()).toBe(before.brands);
      expect(await tx.attribute.count()).toBe(before.attributes);
      expect(await tx.auditLog.count({ where: { entity: "product" } })).toBe(before.audit);
    });
  });

  it("după importul obișnuit, aceeași descriere în fișier = «neschimbat» (idempotență), fără nicio scriere", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const products = await tx.product.count();
      const audit = await tx.auditLog.count({ where: { entity: "product" } });

      const { validation } = await validate(service, owner, ONLY);
      expect(validation.report.counts).toMatchObject({ new: 0, updated: 0, errors: 0 });
      expect(validation.report.counts.unchanged).toBeGreaterThan(5);
      expect(validation.report.woo?.stats.descriptionsKeptEdited).toBe(0);
      await expect(apply(service, owner, validation)).rejects.toMatchObject({
        code: "IMPORT_NOTHING_TO_APPLY",
      });
      expect(await tx.product.count()).toBe(products);
      expect(await tx.auditLog.count({ where: { entity: "product" } })).toBe(audit);
    });
  });

  it("o descriere schimbată în magazin (fără editare manuală) se restabilește din fișier; dry-run nu scrie, aplicarea schimbă DOAR descrierea", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const original = await descriptionOf(tx, "FIX-101");
      expect(original).toContain("<td>Putere</td>");
      const id = await productIdOf(tx, "FIX-101");
      // alt text în bază, scris direct (fără eveniment de audit): ultimul eveniment rămâne cel al importului
      await tx.product.update({ where: { id }, data: { description: "<p>Altceva</p>" } });
      const snapshot = await tx.product.findUniqueOrThrow({
        where: { id },
        include: { variants: true, categories: true },
      });

      const { validation } = await validate(service, owner, ONLY);
      expect(validation.report.counts).toMatchObject({ updated: 1, errors: 0 });
      // dry-run: nimic nu s-a scris
      expect(await descriptionOf(tx, "FIX-101")).toBe("<p>Altceva</p>");

      const report = await apply(service, owner, validation);
      expect(report.counts).toMatchObject({ updated: 1, errors: 0 });
      expect(await descriptionOf(tx, "FIX-101")).toBe(original);

      // nimic altceva nu s-a atins
      const after = await tx.product.findUniqueOrThrow({
        where: { id },
        include: { variants: true, categories: true },
      });
      expect({ ...after, description: null, updatedAt: null, variants: null }).toEqual({
        ...snapshot,
        description: null,
        updatedAt: null,
        variants: null,
      });
      expect(after.variants.map((v) => [v.sku, v.price, v.salePrice])).toEqual(
        snapshot.variants.map((v) => [v.sku, v.price, v.salePrice]),
      );

      // auditul: un eveniment `product.update` cu descrierea, marcat cu importul
      const events = await tx.auditLog.findMany({
        where: { entity: "product", entityId: id, action: "product.update" },
        orderBy: { createdAt: "desc" },
      });
      const last = events[0]?.after as Record<string, unknown>;
      expect(last["importId"]).toBe(validation.importId);
      expect(Object.keys(last).sort()).toEqual(["description", "importId"]);

      // a doua rulare: neschimbat
      const again = await validate(service, owner, ONLY);
      expect(again.validation.report.counts).toMatchObject({ updated: 0, errors: 0 });
    });
  });

  it("o descriere editată manual se păstrează (raportat), iar cu suprascrierea cerută se înlocuiește", async () => {
    await withWoo(async ({ tx, service, products, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const original = await descriptionOf(tx, "FIX-101");
      const id = await productIdOf(tx, "FIX-101");
      await products.update(owner, id, { description: "<p>Scrisă de un om</p>" });

      const kept = await validate(service, owner, ONLY);
      expect(kept.validation.report.counts).toMatchObject({ updated: 0, errors: 0 });
      expect(kept.validation.report.woo?.stats.descriptionsKeptEdited).toBe(1);
      const row = kept.validation.report.entries.find((r) => r.sku === "FIX-101");
      expect(row).toMatchObject({ outcome: "skipped" });
      expect(row?.messages.join(" ")).toMatch(/editată manual/);
      await expect(apply(service, owner, kept.validation)).rejects.toMatchObject({
        code: "IMPORT_NOTHING_TO_APPLY",
      });
      expect(await descriptionOf(tx, "FIX-101")).toBe("<p>Scrisă de un om</p>");

      const overwrite = await validate(service, owner, {
        ...ONLY,
        overwriteEditedDescriptions: true,
      });
      expect(overwrite.validation.report.counts).toMatchObject({ updated: 1, errors: 0 });
      expect(overwrite.validation.report.woo?.stats.descriptionsKeptEdited).toBe(0);
      expect(overwrite.validation.planHash).not.toBe(kept.validation.planHash);
      await apply(service, owner, overwrite.validation);
      expect(await descriptionOf(tx, "FIX-101")).toBe(original);

      // după suprascriere, ultimul eveniment vine din import: descrierea nu mai e «editată manual»
      await tx.product.update({ where: { id }, data: { description: "<p>Iar altceva</p>" } });
      const third = await validate(service, owner, ONLY);
      expect(third.validation.report.counts).toMatchObject({ updated: 1, errors: 0 });
    });
  });

  it("produsul creat de un om, cu descriere, e protejat la fel ca unul editat ulterior", async () => {
    await withWoo(async ({ tx, service, products, as }) => {
      const owner = await as("owner");
      // produs cu SKU-ul din fișier, creat din admin (evenimentul `product.create` nu vine dintr-un import)
      await products.create(owner, {
        title: "Creat manual",
        description: "<p>Text scris la creare</p>",
        variants: [{ sku: "00123", price: 1000 }],
      });
      const { validation } = await validate(service, owner, ONLY);
      expect(validation.report.woo?.stats.descriptionsKeptEdited).toBe(1);
      expect(await descriptionOf(tx, "00123")).toBe("<p>Text scris la creare</p>");
      // cu suprascrierea cerută explicit, se înlocuiește
      const overwrite = await validate(service, owner, {
        ...ONLY,
        overwriteEditedDescriptions: true,
      });
      expect(overwrite.validation.report.counts.updated).toBe(1);
    });
  });

  it("«editată manual» se citește doar din ultimul eveniment care a scris descrierea", async () => {
    await withWoo(async ({ tx, service, products, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const id = await productIdOf(tx, "FIX-101");
      // restabilirea din fișier: schimbăm descrierea direct (fără audit), ca importul să aibă ceva de făcut
      const restore = async (): Promise<void> => {
        await tx.product.update({ where: { id }, data: { description: "<p>Altceva</p>" } });
      };

      // 1. un om schimbă DOAR titlul: descrierea nu e editată manual
      await restore();
      await products.update(owner, id, { title: "Alt titlu, scris de un om" });
      const afterTitle = await validate(service, owner, ONLY);
      expect(afterTitle.validation.report.woo?.stats.descriptionsKeptEdited).toBe(0);
      expect(afterTitle.validation.report.counts.updated).toBe(1);

      // 2. un eveniment REFUZAT (fără drept) cu cheia «description», mai nou, nu schimbă nimic
      await tx.auditLog.create({
        data: {
          action: "product.update",
          entity: "product",
          entityId: id,
          outcome: "denied",
          after: { description: "<p>refuzat</p>" },
        },
      });
      const afterDenied = await validate(service, owner, ONLY);
      expect(afterDenied.validation.report.woo?.stats.descriptionsKeptEdited).toBe(0);

      // 3. un om schimbă descrierea: acum e editată manual
      await products.update(owner, id, { description: "<p>Scrisă de un om</p>" });
      const afterEdit = await validate(service, owner, ONLY);
      expect(afterEdit.validation.report.woo?.stats.descriptionsKeptEdited).toBe(1);
    });
  });

  it("produsul creat de un om FĂRĂ descriere nu are ce proteja: se completează din fișier", async () => {
    await withWoo(async ({ tx, service, products, as }) => {
      const owner = await as("owner");
      await products.create(owner, {
        title: "Creat manual",
        variants: [{ sku: "00123", price: 1000 }],
      });
      const { validation } = await validate(service, owner, ONLY);
      expect(validation.report.woo?.stats.descriptionsKeptEdited).toBe(0);
      expect(validation.report.counts.updated).toBe(1);
      await apply(service, owner, validation);
      expect(await descriptionOf(tx, "00123")).toContain("Filtru pentru piscine");
    });
  });

  it("produsul se găsește și după ID-ul din magazinul vechi (SKU schimbat în fișier); din coșul de gunoi se ignoră", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const original = await descriptionOf(tx, "FIX-101");
      const id = await productIdOf(tx, "FIX-101");
      await tx.product.update({ where: { id }, data: { description: "<p>Altceva</p>" } });
      const renamed = syntheticWooRows(new Date()).map((row) =>
        row.ID === "101" ? { ...row, SKU: "NU-EXISTA-IN-MAGAZIN" } : row,
      );

      const found = await validate(service, owner, ONLY, renamed);
      expect(found.validation.report.counts).toMatchObject({ updated: 1, errors: 0 });
      await apply(service, owner, found.validation);
      expect(await descriptionOf(tx, "FIX-101")).toBe(original);

      // același produs, în coșul de gunoi, găsit doar prin ID-ul vechi: ignorat
      await tx.product.update({
        where: { id },
        data: { deletedAt: new Date(), description: "<p>Altceva</p>" },
      });
      const trashed = await validate(service, owner, ONLY, renamed);
      expect(trashed.validation.report.counts).toMatchObject({ updated: 0, errors: 0 });
      const row = trashed.validation.report.entries.find((r) => r.sku === "NU-EXISTA-IN-MAGAZIN");
      expect(row).toMatchObject({ outcome: "skipped" });
      expect(row?.messages.join(" ")).toMatch(/coșul de gunoi/);
    });
  });

  it("fără istoric de audit: descrierea e protejată (cu contor propriu) și se suprascrie doar la cerere; fără descriere se completează", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      // două produse scrise direct în bază, fără niciun eveniment de audit (cum sunt cele aduse de importuri anterioare auditului pe entitate)
      const withText = await tx.product.create({
        data: { slug: "fara-istoric-1", title: "Fără istoric", description: "<p>Veche</p>" },
      });
      await tx.productVariant.create({
        data: { productId: withText.id, sku: "00123", price: 1000 },
      });
      const noText = await tx.product.create({
        data: { slug: "fara-istoric-2", title: "Fără text" },
      });
      await tx.productVariant.create({
        data: { productId: noText.id, sku: "WC-103", price: 1000 },
      });

      const kept = await validate(service, owner, ONLY);
      const stats = kept.validation.report.woo?.stats;
      expect(stats?.descriptionsKeptNoHistory).toBe(1);
      expect(stats?.descriptionsKeptEdited).toBe(0);
      // cel fără descriere (NULL) se completează
      expect(kept.validation.report.counts.updated).toBe(1);
      const row = kept.validation.report.entries.find((r) => r.sku === "00123");
      expect(row).toMatchObject({ outcome: "skipped" });
      expect(row?.messages.join(" ")).toMatch(/fără istoric, protejat/);
      expect(kept.validation.report.woo?.descriptionsOnly).toEqual({ updated: 1 });
      await apply(service, owner, kept.validation);
      expect(await descriptionOf(tx, "00123")).toBe("<p>Veche</p>");
      expect(await descriptionOf(tx, "WC-103")).toBe("<p>Text normal &amp; sigur.</p><p>Final</p>");

      // cu suprascrierea cerută explicit, se înlocuiește
      const overwrite = await validate(service, owner, {
        ...ONLY,
        overwriteEditedDescriptions: true,
      });
      expect(overwrite.validation.report.woo?.stats.descriptionsKeptNoHistory).toBe(0);
      expect(overwrite.validation.report.counts.updated).toBe(1);
      await apply(service, owner, overwrite.validation);
      expect(await descriptionOf(tx, "00123")).toContain("Filtru pentru piscine");
    });
  });

  it("produsul din coșul de gunoi se ignoră; o celulă goală în fișier nu șterge descrierea", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      await fullImport(service, owner);
      const trashed = await productIdOf(tx, "FIX-101");
      await tx.product.update({
        where: { id: trashed },
        data: { deletedAt: new Date(), description: "<p>Veche</p>" },
      });
      const withEmpty = syntheticWooRows(new Date()).map((row) =>
        row.SKU === "00123" ? { ...row, Descriere: "" } : row,
      );
      const keep = await descriptionOf(tx, "00123");
      expect(keep).not.toBeNull();
      // un produs de restabilit, ca aplicarea să aibă ceva de făcut
      const other = await productIdOf(tx, "WC-103");
      await tx.product.update({ where: { id: other }, data: { description: "<p>zzz</p>" } });
      const { validation } = await validate(service, owner, ONLY, withEmpty);
      expect(validation.report.counts).toMatchObject({ updated: 1, errors: 0 });
      const deletedRow = validation.report.entries.find((r) => r.sku === "FIX-101");
      expect(deletedRow).toMatchObject({ outcome: "skipped" });
      expect(deletedRow?.messages.join(" ")).toMatch(/coșul de gunoi/);
      await apply(service, owner, validation);
      expect(await descriptionOf(tx, "FIX-101")).toBe("<p>Veche</p>");
      expect(await descriptionOf(tx, "00123")).toBe(keep);
      expect(await descriptionOf(tx, "WC-103")).toBe("<p>Text normal &amp; sigur.</p><p>Final</p>");
    });
  });

  it("opțiunile salvate înainte de pasul 8 (fără «mode») rămân importul obișnuit", async () => {
    await withWoo(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const analysis = await service.register(owner, fileOf());
      // opțiunile de dinainte de pasul 8: aceleași, fără cele două câmpuri noi
      const legacy = Object.fromEntries(
        Object.entries(analysis.woo?.defaults ?? {}).filter(
          ([key]) => key !== "mode" && key !== "overwriteEditedDescriptions",
        ),
      );
      expect(Object.keys(legacy)).not.toContain("mode");
      const validation = await service.validate(owner, {
        importId: analysis.importId,
        profile: "woocommerce",
        options: legacy,
      });
      expect(validation.report.counts.new).toBe(7);
      expect(await tx.product.count({ where: { variants: { some: { sku: "FIX-101" } } } })).toBe(0);
    });
  });
});
