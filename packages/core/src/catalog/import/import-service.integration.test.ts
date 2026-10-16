import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import writeExcelFile from "write-excel-file/node";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../../audit/audit-service";
import { createPrismaAuditStore } from "../../audit/prisma-store";
import { PermissionService } from "../../rbac/permission-service";
import { runBaseSeed } from "../../seed/base-seed";
import { settingGroups } from "../../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";
import { createProductImportService } from "./import-runtime";
import type { ImportJobQueue } from "./import-service";

/**
 * Importul de produse pe baza reală: dry-run fără modificări, aplicare exactă a ce s-a verificat,
 * idempotență, rânduri cu erori, coloană de cost refuzată, un singur eveniment de audit, job în fundal.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const logger = createLogger({ destination: { write() {} } });
const importDefaults = z.object(settingGroups.import).parse({});

/** Stocare în memorie cu interfața folosită de import. */
function memoryStorage() {
  const files = new Map<string, Buffer>();
  const storage = {
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
  return { files, storage };
}

async function withImport<T>(
  fn: (c: {
    tx: TestTx;
    service: ReturnType<typeof createProductImportService>;
    files: Map<string, Buffer>;
    queued: string[];
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
    reconfigure: (over: Partial<typeof importDefaults>) => void;
    tag: string;
  }) => Promise<T>,
  options: { withQueue?: boolean } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const { files, storage } = memoryStorage();
    const queued: string[] = [];
    const queue: ImportJobQueue = {
      async enqueue(importId) {
        queued.push(importId);
      },
    };
    let overrides: Partial<typeof importDefaults> = {};
    const service = createProductImportService({
      db: tx as unknown as PrismaClient,
      storage,
      settings: {
        async getGroup(group: string) {
          if (group === "import") return { ...importDefaults, ...overrides };
          if (group === "inventory") return { manageStock: true };
          if (group === "catalog") return { defaultWarrantyMonths: 24 };
          throw new Error(`grup neașteptat: ${group}`);
        },
      } as never,
      audit: new AuditService(createPrismaAuditStore(tx)),
      logger,
      ...(options.withQueue && { queue }),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `imp-${role}-${n++}`, name: role, email: `imp-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({
      tx,
      service,
      files,
      queued,
      as,
      reconfigure: (over) => {
        overrides = over;
      },
      tag: uid(),
    });
  });
}

const csv = (rows: string[][]): { bytes: Uint8Array; fileName: string } => ({
  bytes: new TextEncoder().encode(rows.map((r) => r.join(";")).join("\r\n") + "\r\n"),
  fileName: "import.csv",
});

const columns = (...keys: (string | null)[]) => keys;

/** Catalog de pornire: o categorie cu subcategorie, un brand și trei produse (activ, arhivat, șters). */
async function baseline(tx: TestTx, tag: string) {
  const parent = await tx.category.create({
    data: { slug: `imp-c-${tag}`, name: `Pompe ${tag}`, path: `imp-c-${tag}`, depth: 0 },
  });
  const child = await tx.category.create({
    data: {
      slug: `imp-c-${tag}-circ`,
      name: "Circulație",
      path: `imp-c-${tag}/imp-c-${tag}-circ`,
      depth: 1,
      parentId: parent.id,
    },
  });
  const brand = await tx.brand.create({ data: { slug: `imp-b-${tag}`, name: `Marca ${tag}` } });
  const make = async (
    sku: string,
    over: { status?: string; deletedAt?: Date | null; price?: number } = {},
  ) => {
    const product = await tx.product.create({
      data: {
        slug: `imp-p-${sku.toLowerCase()}-${tag}`,
        title: `Produs ${sku}`,
        status: over.status ?? "draft",
        deletedAt: over.deletedAt ?? null,
      },
    });
    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku,
        price: over.price ?? 10_000,
        isDefault: true,
        // prețul de achiziție există în baza de date, dar nu poate ajunge în raport
        costPrice: 777_777,
        costPriceDate: new Date(),
      },
    });
    return { product, variant };
  };
  return {
    parent,
    child,
    brand,
    existing: await make(`EX-${tag}`),
    archived: await make(`AR-${tag}`, { status: "archived" }),
    trashed: await make(`DEL-${tag}`, { status: "active", deletedAt: new Date() }),
    make,
  };
}

const HEAD = ["SKU", "Titlu", "Preț", "Categorii", "Brand"];
const MAP = columns("sku", "title", "price", "categories", "brand");

describe("import pe baza reală", () => {
  it("dry-run fără modificări; aplicare exactă; un singur eveniment de audit; fișierul se șterge", async () => {
    await withImport(async ({ tx, service, files, as, tag }) => {
      const manager = await as("manager");
      const base = await baseline(tx, tag);
      const productsBefore = await tx.product.count();
      const file = csv([
        HEAD,
        [`EX-${tag}`, "Titlu nou", "150,50", `Pompe ${tag} > Circulație`, `Marca ${tag}`],
        [`NEW-${tag}`, "Produs importat", "1299", `pompe ${tag} > circulatie`, ""],
        [`BAD-${tag}`, "Preț greșit", "abc", "", ""],
        [`CAT-${tag}`, "Categorie lipsă", "10", `Piscine ${tag}`, ""],
        [`AR-${tag}`, "Nu se atinge", "10", "", ""],
        [`DEL-${tag}`, "Nu se atinge", "10", "", ""],
      ]);

      const analysis = await service.register(manager, file);
      expect(analysis).toMatchObject({ format: "csv", delimiter: ";", rowCount: 6 });
      expect(analysis.columns.map((c) => c.field)).toEqual([
        "sku",
        "title",
        "price",
        "categories",
        "brand",
      ]);
      expect(files.size).toBe(1);
      const [key] = [...files.keys()];
      expect(key).toMatch(/^private\/product-imports\/[0-9a-f-]{36}\.csv$/);

      // dry-run
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: MAP,
      });
      expect(validation.report.counts).toEqual({
        new: 1,
        updated: 1,
        unchanged: 0,
        skipped: 2,
        errors: 2,
        warnings: 2,
      });
      expect(validation.mode).toBe("sync");
      // nimic în catalog
      expect(await tx.product.count()).toBe(productsBefore);
      expect(
        (await tx.product.findUniqueOrThrow({ where: { id: base.existing.product.id } })).title,
      ).toBe(`Produs EX-${tag}`);
      // jurnalul nu se șterge: se numără doar evenimentele acestui import
      expect(
        await tx.auditLog.count({
          where: { action: "product.import", entityId: analysis.importId },
        }),
      ).toBe(0);

      // aplicare
      const applied = await service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      expect(applied.mode).toBe("sync");

      const updated = await tx.product.findUniqueOrThrow({
        where: { id: base.existing.product.id },
        include: { variants: true, categories: true },
      });
      expect(updated.title).toBe("Titlu nou");
      expect(updated.brandId).toBe(base.brand.id);
      expect(updated.categories.map((c) => c.categoryId)).toEqual([base.child.id]);
      expect(updated.variants[0]?.price).toBe(15_050);
      // istoricul de prețuri a primit prețul nou
      expect(
        await tx.priceHistory.count({
          where: { variantId: base.existing.variant.id, price: 15_050 },
        }),
      ).toBe(1);

      const created = await tx.productVariant.findFirstOrThrow({
        where: { sku: `NEW-${tag}` },
        include: { product: { include: { categories: true } } },
      });
      expect(created).toMatchObject({ price: 129_900, ean: null, isDefault: true });
      expect(created.product).toMatchObject({ status: "draft", title: "Produs importat" });
      expect(created.product.categories.map((c) => c.categoryId)).toEqual([base.child.id]);
      expect(created.costPrice).toBeNull();

      // arhivatul și cel din coșul de gunoi nu s-au atins
      expect(
        (await tx.product.findUniqueOrThrow({ where: { id: base.archived.product.id } })).title,
      ).toBe(`Produs AR-${tag}`);
      expect(
        (await tx.product.findUniqueOrThrow({ where: { id: base.trashed.product.id } })).title,
      ).toBe(`Produs DEL-${tag}`);
      // costul existent a rămas neatins
      expect(
        (await tx.productVariant.findUniqueOrThrow({ where: { id: base.existing.variant.id } }))
          .costPrice,
      ).toBe(777_777);

      // UN singur eveniment de audit pentru import, fără evenimentele pe rând
      const events = await tx.auditLog.findMany({
        where: { action: "product.import", entityId: analysis.importId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.after).toMatchObject({ created: 1, updated: 1, skipped: 2, errors: 2 });
      expect(
        await tx.auditLog.count({
          where: {
            action: { in: ["product.create", "product.update", "product.variant.update"] },
            entityId: {
              in: [created.productId, base.existing.product.id, base.existing.variant.id],
            },
          },
        }),
      ).toBe(0);

      // fișierul a fost șters, importul e încheiat, raportul nu conține costul
      expect(files.size).toBe(0);
      const row = await tx.productImport.findUniqueOrThrow({ where: { id: analysis.importId } });
      expect(row).toMatchObject({ status: "completed", storageKey: null, processedRows: 6 });
      expect(JSON.stringify(row)).not.toContain("777777");
      expect(JSON.stringify(events)).not.toContain("777777");
    });
  });

  it("idempotent: a doua rulare a aceluiași fișier nu dublează și nu schimbă nimic", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      await baseline(tx, tag);
      const file = csv([
        HEAD,
        [`EX-${tag}`, "Titlu nou", "150,50", "", ""],
        [`NEW-${tag}`, "Produs importat", "1299", "", ""],
      ]);
      const run = async () => {
        const analysis = await service.register(manager, file);
        const validation = await service.validate(manager, {
          importId: analysis.importId,
          columns: MAP,
        });
        return { analysis, validation };
      };

      const first = await run();
      await service.apply(manager, {
        importId: first.analysis.importId,
        confirm: true,
        expectedPlanHash: first.validation.planHash,
      });
      const productsAfterFirst = await tx.product.count();

      const second = await run();
      expect(second.validation.report.counts).toMatchObject({ new: 0, updated: 0, unchanged: 2 });
      await expect(
        service.apply(manager, {
          importId: second.analysis.importId,
          confirm: true,
          expectedPlanHash: second.validation.planHash,
        }),
      ).rejects.toMatchObject({ code: "IMPORT_NOTHING_TO_APPLY" });
      expect(await tx.product.count()).toBe(productsAfterFirst);
    });
  });

  it("amprenta leagă aplicarea de ce s-a verificat: dacă s-a schimbat catalogul, aplicarea e refuzată și nu scrie nimic", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      await baseline(tx, tag);
      const analysis = await service.register(
        manager,
        csv([HEAD, [`NEW-${tag}`, "Produs importat", "10", "", ""]]),
      );
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: MAP,
      });
      expect(validation.report.counts.new).toBe(1);

      // între verificare și aplicare, cineva creează același SKU
      const other = await tx.product.create({
        data: { slug: `imp-x-${tag}`, title: "Apărut între timp" },
      });
      await tx.productVariant.create({
        data: { productId: other.id, sku: `NEW-${tag}`, price: 5, isDefault: true },
      });

      await expect(
        service.apply(manager, {
          importId: analysis.importId,
          confirm: true,
          expectedPlanHash: validation.planHash,
        }),
      ).rejects.toMatchObject({ code: "IMPORT_STALE" });
      expect(await tx.productVariant.count({ where: { sku: `NEW-${tag}` } })).toBe(1);
      expect(
        (await tx.productImport.findUniqueOrThrow({ where: { id: analysis.importId } })).status,
      ).toBe("validated");

      // și o amprentă trimisă greșit de client
      await expect(
        service.apply(manager, {
          importId: analysis.importId,
          confirm: true,
          expectedPlanHash: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "IMPORT_STALE" });
    });
  });

  it("coloana de cost: maparea e refuzată (pe antet și pe numele câmpului), costul nu intră nicăieri", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      await baseline(tx, tag);
      const SENTINEL = "987654321";
      const analysis = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț", "Preț achiziție"],
          [`NEW-${tag}`, "Produs", "10", SENTINEL],
        ]),
      );
      expect(analysis.columns[3]).toEqual({ field: null, blocked: "cost" });

      // maparea coloanei de cost pe prețul de vânzare
      await expect(
        service.validate(manager, {
          importId: analysis.importId,
          columns: columns("sku", "title", null, "price"),
        }),
      ).rejects.toMatchObject({ code: "IMPORT_MAPPING_COST" });
      // un nume de câmp de cost trimis direct
      for (const field of ["costPrice", "purchasePrice", "cost"]) {
        await expect(
          service.validate(manager, {
            importId: analysis.importId,
            columns: columns("sku", "title", "price", field),
          }),
        ).rejects.toMatchObject({ code: "IMPORT_MAPPING_COST" });
      }

      // maparea corectă: coloana de cost rămâne nemapată, cu avertisment, iar valoarea nu apare nicăieri
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: columns("sku", "title", "price", null),
      });
      expect(validation.report.fileWarnings.join("|")).toMatch(/Preț achiziție.*nu se importă/);
      await service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      const row = await tx.productImport.findUniqueOrThrow({ where: { id: analysis.importId } });
      const events = await tx.auditLog.findMany({ where: { entityId: analysis.importId } });
      expect(JSON.stringify([row, events])).not.toContain(SENTINEL);
      expect(
        (await tx.productVariant.findFirstOrThrow({ where: { sku: `NEW-${tag}` } })).costPrice,
      ).toBeNull();
    });
  });

  it("permisiuni: Editorul nu poate importa; importul e doar al celui care l-a încărcat", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      await baseline(tx, tag);
      const editor = await as("editor");
      const manager = await as("manager");
      const other = await as("manager");
      const file = csv([HEAD, [`NEW-${tag}`, "Produs", "10", "", ""]]);

      await expect(service.register(editor, file)).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      await expect(service.register(null, file)).rejects.toMatchObject({
        code: "AUTH_UNAUTHENTICATED",
      });

      const analysis = await service.register(manager, file);
      for (const intruder of [other, editor]) {
        await expect(
          service.validate(intruder, { importId: analysis.importId, columns: MAP }),
        ).rejects.toMatchObject({ code: expect.stringMatching(/IMPORT_NOT_FOUND|AUTH_FORBIDDEN/) });
      }
      await expect(service.status(other, analysis.importId)).rejects.toMatchObject({
        code: "IMPORT_NOT_FOUND",
      });
      await expect(service.cancel(other, analysis.importId)).rejects.toMatchObject({
        code: "IMPORT_NOT_FOUND",
      });
      expect((await service.status(manager, analysis.importId)).status).toBe("uploaded");
    });
  });

  it("XLSX: se încarcă, se verifică și se aplică; EAN-ul text își păstrează zerourile", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      await baseline(tx, tag);
      const text = (value: string) => ({ value, type: String });
      const buffer = await writeExcelFile([
        [text("SKU"), text("Titlu"), text("Preț (lei, cu TVA)"), text("EAN")],
        [text(`NEW-${tag}`), text("Din XLSX"), text("249,90"), text("05901234123457")],
      ]).toBuffer();
      const analysis = await service.register(manager, {
        bytes: new Uint8Array(buffer),
        fileName: "produse.xlsx",
      });
      expect(analysis).toMatchObject({ format: "xlsx", delimiter: null, rowCount: 1 });
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: analysis.columns.map((c) => c.field),
      });
      expect(validation.report.counts).toMatchObject({ new: 1, errors: 0 });
      await service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      const variant = await tx.productVariant.findFirstOrThrow({ where: { sku: `NEW-${tag}` } });
      expect(variant).toMatchObject({ price: 24_990, ean: "05901234123457" });
    });
  });

  it("fișier mare: se pune în coadă (starea «queued»), jobul îl rulează și raportează progresul final", async () => {
    await withImport(
      async ({ tx, service, queued, as, reconfigure, tag }) => {
        const manager = await as("manager");
        await baseline(tx, tag);
        reconfigure({ syncMaxRows: 2 });
        const rows = Array.from({ length: 5 }, (_, i) => [
          `Q${i}-${tag}`,
          `Produs ${i}`,
          `${10 + i}`,
          "",
          "",
        ]);
        const analysis = await service.register(manager, csv([HEAD, ...rows]));
        const validation = await service.validate(manager, {
          importId: analysis.importId,
          columns: MAP,
        });
        expect(validation.mode).toBe("background");

        const applied = await service.apply(manager, {
          importId: analysis.importId,
          confirm: true,
          expectedPlanHash: validation.planHash,
        });
        expect(applied.mode).toBe("background");
        expect(queued).toEqual([analysis.importId]);
        expect((await service.status(manager, analysis.importId)).status).toBe("queued");
        // nimic nu s-a scris încă
        expect(await tx.productVariant.count({ where: { sku: { startsWith: "Q" } } })).toBe(0);

        await service.runQueued(analysis.importId);
        const status = await service.status(manager, analysis.importId);
        expect(status).toMatchObject({ status: "completed", processedRows: 5 });
        expect(status.summary).toMatchObject({ new: 5, errors: 0 });
        expect(
          await tx.productVariant.count({
            where: { sku: { endsWith: `-${tag}` }, product: { title: { startsWith: "Produs " } } },
          }),
        ).toBeGreaterThanOrEqual(5);
        // jobul repetat (livrat de două ori) nu face nimic
        await service.runQueued(analysis.importId);
        expect(
          await tx.auditLog.count({
            where: { action: "product.import", entityId: analysis.importId },
          }),
        ).toBe(1);
      },
      { withQueue: true },
    );
  });

  it("jobul din fundal reverifică permisiunea: contul care a pornit importul și-a pierdut dreptul → eșuat, nimic aplicat", async () => {
    await withImport(
      async ({ tx, service, as, reconfigure, tag }) => {
        const manager = await as("manager");
        await baseline(tx, tag);
        reconfigure({ syncMaxRows: 1 });
        const analysis = await service.register(
          manager,
          csv([HEAD, [`Q1-${tag}`, "A", "1", "", ""], [`Q2-${tag}`, "B", "2", "", ""]]),
        );
        const validation = await service.validate(manager, {
          importId: analysis.importId,
          columns: MAP,
        });
        await service.apply(manager, {
          importId: analysis.importId,
          confirm: true,
          expectedPlanHash: validation.planHash,
        });
        // între timp, rolul îi este retras
        await tx.userRole.deleteMany({ where: { userId: manager?.userId as string } });

        await service.runQueued(analysis.importId);
        const row = await tx.productImport.findUniqueOrThrow({ where: { id: analysis.importId } });
        expect(row.status).toBe("failed");
        expect(row.errorMessage).toMatch(/nu mai are permisiunea/);
        expect(await tx.productVariant.count({ where: { sku: { startsWith: "Q1-" } } })).toBe(0);
      },
      { withQueue: true },
    );
  });

  it("curățare: importurile expirate (cu fișier) dispar la următoarea încărcare; cele în lucru rămân", async () => {
    await withImport(async ({ tx, service, files, as, tag }) => {
      const manager = await as("manager");
      await baseline(tx, tag);
      const old = await service.register(manager, csv([HEAD, [`A-${tag}`, "A", "1", "", ""]]));
      const running = await service.register(manager, csv([HEAD, [`B-${tag}`, "B", "1", "", ""]]));
      const past = new Date(Date.now() - 60_000);
      await tx.productImport.update({ where: { id: old.importId }, data: { expiresAt: past } });
      await tx.productImport.update({
        where: { id: running.importId },
        data: { expiresAt: past, status: "running" },
      });
      expect(files.size).toBe(2);

      await service.register(manager, csv([HEAD, [`C-${tag}`, "C", "1", "", ""]]));
      expect(await tx.productImport.findUnique({ where: { id: old.importId } })).toBeNull();
      expect(await tx.productImport.findUnique({ where: { id: running.importId } })).not.toBeNull();
      expect(files.size).toBe(2);
    });
  });

  it("raportul CSV: rândurile cu erori și ignorate, cu motiv; valorile câmpurilor lungi nu apar", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const base = await baseline(tx, tag);
      void base;
      const analysis = await service.register(
        manager,
        csv([HEAD, [`BAD-${tag}`, "x", "abc", "", ""], [`AR-${tag}`, "y", "5", "", ""]]),
      );
      await service.validate(manager, { importId: analysis.importId, columns: MAP });
      const { csv: text, fileName } = await service.reportCsv(manager, analysis.importId);
      expect(fileName).toBe("raport-import-produse.csv");
      expect(text.startsWith(String.fromCharCode(0xfeff) + "sep=;\r\nRând;SKU;")).toBe(true);
      expect(text).toContain("Rând;SKU;Rezultat;Motiv");
      expect(text).toContain(`BAD-${tag};eroare;`);
      expect(text).toContain(`AR-${tag};ignorat;`);
    });
  });

  it("CHECK-urile tabelului: stare, format și progres nevalide sunt refuzate de bază", async () => {
    await withImport(async ({ tx, as, tag }) => {
      const manager = await as("manager");
      const data = {
        createdById: manager?.userId as string,
        fileName: "f.csv",
        format: "csv",
        sizeBytes: 10,
        fileHash: "a".repeat(64),
        rowCount: 5,
        expiresAt: new Date(Date.now() + 1000),
      };
      const attempt = async (over: Record<string, unknown>) => {
        await tx.$executeRawUnsafe("SAVEPOINT chk");
        try {
          await tx.productImport.create({
            data: { ...data, storageKey: `k-${uid()}-${tag}`, ...over },
          });
          return "acceptat";
        } catch {
          return "refuzat";
        } finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT chk");
        }
      };
      expect(await attempt({})).toBe("acceptat");
      expect(await attempt({ status: "inventat" })).toBe("refuzat");
      expect(await attempt({ format: "xls" })).toBe("refuzat");
      expect(await attempt({ sizeBytes: 0 })).toBe("refuzat");
      expect(await attempt({ rowCount: 0 })).toBe("refuzat");
      expect(await attempt({ processedRows: 6 })).toBe("refuzat");
      expect(await attempt({ delimiter: "|" })).toBe("refuzat");
      // delimitator nul sau valid: acceptat (CHECK-ul tratează explicit NULL)
      expect(await attempt({ delimiter: null })).toBe("acceptat");
      expect(await attempt({ delimiter: ";" })).toBe("acceptat");
    });
  });
});

void vi;
