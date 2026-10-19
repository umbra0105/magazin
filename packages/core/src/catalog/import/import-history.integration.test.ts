import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { WOO_COST_SENTINEL, syntheticWooRows, wooCsv } from "../../../test/woo-fixture";
import { AuditService } from "../../audit/audit-service";
import { createPrismaAuditStore } from "../../audit/prisma-store";
import { MemoryCounterStore } from "../../auth/counter-store";
import { MediaUploadGuard } from "../../media/upload-guard";
import { PermissionService } from "../../rbac/permission-service";
import { runBaseSeed } from "../../seed/base-seed";
import { settingGroups } from "../../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";
import { createProductExportService } from "../export/export-runtime";
import { handleProductImportReport } from "./import-handler";
import { createProductImportService } from "./import-runtime";

/**
 * Istoricul importurilor pe baza reală: un import aplicat rămâne în istoric (fișierul se șterge), cele doar
 * verificate nu apar, retenția șterge detaliul și păstrează contoarele, un import întrerupt e vizibil, rolurile
 * fără products.write nu văd nimic, raportul descărcat nu conține costul. Plus istoricul exporturilor.
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
    _files: files,
  } as unknown as StorageDriver;
}

type Subject = Awaited<ReturnType<PermissionService["loadSubject"]>>;

async function withHistory<T>(
  fn: (c: {
    tx: TestTx;
    service: ReturnType<typeof createProductImportService>;
    exporter: ReturnType<typeof createProductExportService>;
    storage: StorageDriver & { _files: Map<string, Buffer> };
    as: (role: string) => Promise<Subject>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const storage = memoryStorage() as StorageDriver & { _files: Map<string, Buffer> };
    const audit = new AuditService(createPrismaAuditStore(tx));
    const settings = {
      async getGroup(group: string) {
        if (group === "import") return importDefaults;
        if (group === "productExport") return { maxRows: 20_000 };
        if (group === "inventory") return { manageStock: true };
        if (group === "catalog") return { defaultWarrantyMonths: 24 };
        if (group === "regional") return { timezone: "Europe/Bucharest" };
        throw new Error(`grup neașteptat: ${group}`);
      },
      async getGroupUncached(group: string) {
        if (group === "imageImport") return z.object(settingGroups.imageImport).parse({});
        throw new Error(`grup neașteptat: ${group}`);
      },
    } as never;
    const service = createProductImportService({
      db: tx as unknown as PrismaClient,
      storage,
      settings,
      audit,
      logger,
    });
    const exporter = createProductExportService({
      db: tx as unknown as PrismaClient,
      settings,
      audit,
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: {
          id: `hist-${role}-${n++}`,
          name: `Nume ${role} ${n}`,
          email: `hist-${role}-${n}@test.invalid`,
        },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, exporter, storage, as });
  });
}

const csv = (rows: string[][]) => ({
  bytes: new TextEncoder().encode(rows.map((r) => r.join(";")).join("\r\n") + "\r\n"),
  fileName: "istoric.csv",
});

/** Un import generic mic, verificat și aplicat; întoarce id-ul. */
async function applyGeneric(
  service: ReturnType<typeof createProductImportService>,
  subject: Subject,
  tag: string,
): Promise<string> {
  const analysis = await service.register(
    subject,
    csv([
      ["SKU", "Titlu", "Preț"],
      [`H-${tag}-1`, "Produs unu", "10"],
      [`H-${tag}-2`, "Produs doi", "abc"],
    ]),
  );
  const validation = await service.validate(subject, {
    importId: analysis.importId,
    columns: ["sku", "title", "price"],
  });
  await service.apply(subject, {
    importId: validation.importId,
    confirm: true,
    expectedPlanHash: validation.planHash,
  });
  return analysis.importId;
}

describe("istoricul importurilor pe baza reală", () => {
  it("un import aplicat apare în istoric cu utilizatorul, profilul și contoarele, iar fișierul original e șters", async () => {
    await withHistory(async ({ service, storage, as }) => {
      const manager = await as("manager");
      const id = await applyGeneric(service, manager, "a1");
      expect(storage._files.size).toBe(0); // fișierul original nu se păstrează

      const page = await service.listHistory(manager, 1);
      const item = page.items.find((i) => i.id === id);
      expect(item).toMatchObject({
        state: "completed",
        fileName: "istoric.csv",
        format: "csv",
        profile: "generic",
        rowCount: 2,
        hasReport: true,
      });
      expect(item?.userName).toBe(`Nume manager 1`);
      expect(item?.counts).toMatchObject({ new: 1, errors: 1, updated: 0, unchanged: 0 });
      expect(item?.reportUntil).toBeInstanceOf(Date);
      expect(page.retentionDays).toBe(180);
    });
  });

  it("importurile doar verificate sau anulate NU intră în istoric", async () => {
    await withHistory(async ({ service, as }) => {
      const manager = await as("manager");
      const verified = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["V-1", "X", "10"],
        ]),
      );
      await service.validate(manager, {
        importId: verified.importId,
        columns: ["sku", "title", "price"],
      });
      const cancelled = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["V-2", "X", "10"],
        ]),
      );
      await service.cancel(manager, cancelled.importId);
      const uploaded = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["V-3", "X", "10"],
        ]),
      );
      const page = await service.listHistory(manager, 1);
      const ids = page.items.map((i) => i.id);
      for (const id of [verified.importId, cancelled.importId, uploaded.importId]) {
        expect(ids).not.toContain(id);
      }
      await expect(service.getHistory(manager, verified.importId)).rejects.toMatchObject({
        code: "IMPORT_NOT_FOUND",
      });
    });
  });

  it("istoricul arată importurile tuturor utilizatorilor; raportul se descarcă de oricine are products.write", async () => {
    await withHistory(async ({ service, as }) => {
      const first = await as("manager");
      const second = await as("admin");
      const id = await applyGeneric(service, first, "b1");
      const seenBySecond = await service.listHistory(second, 1);
      expect(seenBySecond.items.some((i) => i.id === id)).toBe(true);
      const detail = await service.getHistory(second, id);
      expect(detail.report?.entries.some((e) => e.outcome === "error")).toBe(true);
      const { rows } = await service.reportRows(second, id);
      expect(rows[0]).toEqual(["Rând", "SKU", "Rezultat", "Motiv", "Câmpuri schimbate"]);
      expect(rows.some((r) => r[2] === "eroare")).toBe(true);
    });
  });

  it("retenția: după termen, detaliul se șterge și contoarele rămân; CSV-ul dă «șters»", async () => {
    await withHistory(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const id = await applyGeneric(service, manager, "c1");
      // termenul de păstrare a trecut
      await tx.productImport.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const page = await service.listHistory(manager, 1);
      const item = page.items.find((i) => i.id === id);
      expect(item).toMatchObject({ state: "completed", hasReport: false, reportUntil: null });
      expect(item?.counts).toMatchObject({ new: 1, errors: 1 });
      const stored = await tx.productImport.findUniqueOrThrow({ where: { id } });
      expect(stored.report).toBeNull();
      expect(stored.summary).not.toBeNull();

      const detail = await service.getHistory(manager, id);
      expect(detail.report).toBeNull();
      await expect(service.reportRows(manager, id)).rejects.toMatchObject({
        code: "IMPORT_REPORT_PURGED",
      });
      const response = await handleProductImportReport(id, {
        getSubject: async () => manager,
        service,
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ code: "IMPORT_REPORT_PURGED" });
    });
  });

  it("un import care a rămas «în rulare» fără progres apare ca întrerupt, cu rândurile aplicate; unul recent e «în curs»", async () => {
    await withHistory(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const stale = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["I-1", "X", "10"],
        ]),
      );
      const fresh = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["I-2", "X", "10"],
        ]),
      );
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
      await tx.productImport.update({
        where: { id: stale.importId },
        data: {
          status: "running",
          processedRows: 7,
          rowCount: 20,
          startedAt: hoursAgo(3),
          updatedAt: hoursAgo(2),
        },
      });
      await tx.productImport.update({
        where: { id: fresh.importId },
        data: {
          status: "running",
          processedRows: 3,
          rowCount: 20,
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const page = await service.listHistory(manager, 1);
      const byId = new Map(page.items.map((i) => [i.id, i]));
      expect(byId.get(stale.importId)).toMatchObject({
        state: "interrupted",
        processedRows: 7,
        rowCount: 20,
        counts: null,
      });
      expect(byId.get(fresh.importId)).toMatchObject({ state: "running", processedRows: 3 });
      // un import întrerupt nu are raport final și nu se descarcă
      expect((await service.getHistory(manager, stale.importId)).report).toBeNull();
      await expect(service.reportRows(manager, stale.importId)).rejects.toMatchObject({
        code: "IMPORT_STATE_INVALID",
      });
      // și nu e șters de curățarea importurilor neaplicate
      await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["I-3", "X", "10"],
        ]),
      );
      expect(await tx.productImport.count({ where: { id: stale.importId } })).toBe(1);
    });
  });

  it("un import eșuat apare cu motivul; importurile expirate neaplicate se șterg, cele aplicate nu", async () => {
    await withHistory(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const done = await applyGeneric(service, manager, "d1");
      const old = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["E-1", "X", "10"],
        ]),
      );
      await tx.productImport.update({
        where: { id: old.importId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await tx.productImport.update({
        where: { id: done },
        data: { expiresAt: new Date(Date.now() - 1000), report: undefined },
      });
      await service.purgeExpired();
      expect(await tx.productImport.count({ where: { id: old.importId } })).toBe(0);
      expect(await tx.productImport.count({ where: { id: done } })).toBe(1);

      const failed = await service.register(
        manager,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["E-2", "X", "10"],
        ]),
      );
      await tx.productImport.update({
        where: { id: failed.importId },
        data: {
          status: "failed",
          errorMessage: "Catalogul s-a schimbat de la verificare.",
          finishedAt: new Date(),
        },
      });
      const item = (await service.listHistory(manager, 1)).items.find(
        (i) => i.id === failed.importId,
      );
      expect(item).toMatchObject({
        state: "failed",
        errorMessage: "Catalogul s-a schimbat de la verificare.",
        counts: null,
      });
    });
  });

  it("rolurile fără products.write nu văd nimic: listă, detalii și CSV refuzate", async () => {
    await withHistory(async ({ service, as }) => {
      const manager = await as("manager");
      const id = await applyGeneric(service, manager, "f1");
      for (const role of ["editor", "support", "warehouse", "accountant"]) {
        const subject = await as(role);
        await expect(service.listHistory(subject, 1), role).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        await expect(service.getHistory(subject, id), role).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        await expect(service.reportRows(subject, id), role).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        const response = await handleProductImportReport(id, {
          getSubject: async () => subject,
          service,
        });
        expect(response.status).toBe(403);
      }
      await expect(service.listHistory(null, 1)).rejects.toMatchObject({
        code: "AUTH_UNAUTHENTICATED",
      });
    });
  });

  it("raportul unui import doar verificat rămâne al utilizatorului care l-a încărcat", async () => {
    await withHistory(async ({ service, as }) => {
      const owner = await as("manager");
      const other = await as("admin");
      const verified = await service.register(
        owner,
        csv([
          ["SKU", "Titlu", "Preț"],
          ["P-1", "X", "10"],
        ]),
      );
      await service.validate(owner, {
        importId: verified.importId,
        columns: ["sku", "title", "price"],
      });
      await expect(service.reportRows(other, verified.importId)).rejects.toMatchObject({
        code: "IMPORT_NOT_FOUND",
      });
      await expect(service.reportRows(owner, verified.importId)).resolves.toBeDefined();
    });
  });

  it("limita proprie de descărcări: peste prag, 429 cu Retry-After", async () => {
    await withHistory(async ({ service, as }) => {
      const manager = await as("manager");
      const id = await applyGeneric(service, manager, "g1");
      const guard = new MediaUploadGuard(
        new MemoryCounterStore(),
        { uploadMaxAttempts: 2, uploadWindowMinutes: 10, refusedAuditMaxAttempts: 5 },
        "product-import-report",
      );
      const deps = {
        getSubject: async () => manager,
        service,
        checkRate: (userId: string) => guard.checkUpload(userId, null),
      };
      expect((await handleProductImportReport(id, deps)).status).toBe(200);
      expect((await handleProductImportReport(id, deps)).status).toBe(200);
      const limited = await handleProductImportReport(id, deps);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    });
  });

  it("WooCommerce: contoarele includ entitățile create; costul din fișier nu apare în istoric, detalii sau CSV", async () => {
    await withHistory(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const analysis = await service.register(owner, {
        bytes: wooCsv(syntheticWooRows()),
        fileName: "woo.csv",
      });
      const validation = await service.validate(owner, {
        importId: analysis.importId,
        profile: "woocommerce",
        options: analysis.woo?.defaults,
      });
      await service.apply(owner, {
        importId: validation.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      const page = await service.listHistory(owner, 1);
      const item = page.items.find((i) => i.id === analysis.importId);
      expect(item).toMatchObject({ state: "completed", profile: "woocommerce" });
      expect(item?.counts).toMatchObject({
        new: 7,
        skipped: 2,
        errors: 6,
        created: { categories: 6, brands: 2, attributes: 1 },
      });
      const detail = await service.getHistory(owner, analysis.importId);
      expect(detail.report?.woo?.categoriesToCreate).toHaveLength(6);
      const { rows } = await service.reportRows(owner, analysis.importId);
      const everything = JSON.stringify({ page, detail, rows });
      expect(everything).not.toContain(WOO_COST_SENTINEL);
      expect(everything).not.toContain("7654321");
      const stored = await tx.productImport.findUniqueOrThrow({ where: { id: analysis.importId } });
      expect(JSON.stringify(stored)).not.toContain(WOO_COST_SENTINEL);
      void randomUUID;
    });
  });

  it("istoricul exporturilor: din auditul product.export, doar numere; cere products.export", async () => {
    await withHistory(async ({ tx, exporter, as }) => {
      const manager = await as("manager");
      const warehouse = await as("warehouse");
      const product = await tx.product.create({
        data: {
          slug: `hx-p-${randomUUID().slice(0, 6)}`,
          title: "Produs istoric export",
          status: "active",
        },
      });
      await tx.productVariant.create({
        data: {
          productId: product.id,
          sku: `HX-${randomUUID().slice(0, 6)}`,
          price: 100,
          isDefault: true,
        },
      });
      const prepared = await exporter.prepare(manager, {
        format: "csv",
        scope: "selection",
        ids: [product.id],
      });
      for await (const row of prepared.rows) void row;
      const history = await exporter.history(manager);
      const mine = history.find((h) => h.actorLabel === manager?.email);
      expect(mine).toMatchObject({
        state: "downloaded",
        format: "csv",
        scope: "selection",
        rows: 1,
        products: 1,
        includeTrash: false,
      });
      expect(JSON.stringify(history)).not.toContain("Produs istoric export");
      await expect(exporter.history(warehouse)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      await expect(exporter.history(null)).rejects.toMatchObject({ code: "AUTH_UNAUTHENTICATED" });
    });
  });
});
