import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../../audit/audit-service";
import { createPrismaAuditStore } from "../../audit/prisma-store";
import { PermissionService } from "../../rbac/permission-service";
import { runBaseSeed } from "../../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";
import { toCsv } from "../import/import-csv";
import { IMPORT_FIELD_KEYS, isCostLikeHeader } from "../import/import-fields";
import { createProductImportService } from "../import/import-runtime";
import { cellToCsvText } from "./export-rows";
import { createProductExportService } from "./export-runtime";
import type { PreparedExport } from "./export-service";
import { buildExportXlsx } from "./export-xlsx";

/**
 * Exportul de produse pe baza reală: domenii (selecție, filtre, tot catalogul, coș de gunoi), limita de
 * rânduri, permisiuni, auditul cu numere, valoarea-santinelă a costului și testul dus-întors (export →
 * import al aceluiași fișier → tot «neschimbat»), pentru CSV și XLSX.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const logger = createLogger({ destination: { write() {} } });

/** Prețul de achiziție al tuturor variantelor din test: o valoare ușor de recunoscut în orice fișier. */
const COST_SENTINEL = 7_654_321;
const COST_FORMS = ["7654321", "76543,21", "76543.21", "76.543,21", "76,543.21", "76543"];

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

async function withExport<T>(
  fn: (c: {
    tx: TestTx;
    exporter: ReturnType<typeof createProductExportService>;
    importer: ReturnType<typeof createProductImportService>;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
    setMaxRows: (n: number) => void;
    tag: string;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    let maxRows = 20_000;
    const audit = new AuditService(createPrismaAuditStore(tx));
    const settings = {
      async getGroup(group: string) {
        if (group === "productExport") return { maxRows };
        if (group === "regional") return { timezone: "Europe/Bucharest" };
        if (group === "import") {
          return {
            maxUploadBytes: 10 * 1024 * 1024,
            maxRows: 5000,
            maxColumns: 60,
            maxCellLength: 100_000,
            maxUncompressedBytes: 60 * 1024 * 1024,
            maxZipEntries: 100,
            syncMaxRows: 100,
            retentionHours: 24,
          };
        }
        if (group === "inventory") return { manageStock: true };
        if (group === "catalog") return { defaultWarrantyMonths: 24 };
        throw new Error(`grup neașteptat: ${group}`);
      },
    } as never;
    const exporter = createProductExportService({
      db: tx as unknown as PrismaClient,
      settings,
      audit,
      logger,
    });
    const importer = createProductImportService({
      db: tx as unknown as PrismaClient,
      storage: memoryStorage(),
      settings,
      audit,
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `exp-${role}-${n++}`, name: role, email: `exp-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({
      tx,
      exporter,
      importer,
      as,
      setMaxRows: (value) => {
        maxRows = value;
      },
      tag: uid(),
    });
  });
}

interface Made {
  id: string;
  skus: string[];
}

/** Catalog de pornire cu cazuri grele pentru dus-întors; fiecare variantă are costul-santinelă. */
async function catalog(tx: TestTx, tag: string) {
  const parent = await tx.category.create({
    data: { slug: `exp-c-${tag}`, name: `Pompe ${tag}`, path: `exp-c-${tag}`, depth: 0 },
  });
  const child = await tx.category.create({
    data: {
      slug: `exp-c-${tag}-circ`,
      name: "Circulație",
      path: `exp-c-${tag}/exp-c-${tag}-circ`,
      depth: 1,
      parentId: parent.id,
    },
  });
  const other = await tx.category.create({
    data: { slug: `exp-o-${tag}`, name: `Accesorii ${tag}`, path: `exp-o-${tag}`, depth: 0 },
  });
  const brand = await tx.brand.create({ data: { slug: `exp-b-${tag}`, name: `Marca ${tag}` } });

  const make = async (
    key: string,
    over: {
      title?: string;
      status?: string;
      deletedAt?: Date | null;
      subtitle?: string | null;
      description?: string | null;
      brandId?: string | null;
      categories?: string[];
      variants?: {
        sku: string;
        price: number;
        salePrice?: number | null;
        ean?: string | null;
        warrantyMonths?: number | null;
        weightGrams?: number | null;
      }[];
    } = {},
  ): Promise<Made> => {
    const variants = over.variants ?? [{ sku: `${key}-${tag}`, price: 10_000 }];
    const product = await tx.product.create({
      data: {
        slug: `exp-p-${key.toLowerCase()}-${tag}`,
        title: over.title ?? `Produs ${key} ${tag}`,
        status: over.status ?? "active",
        deletedAt: over.deletedAt ?? null,
        subtitle: over.subtitle ?? null,
        description: over.description ?? null,
        brandId: over.brandId ?? null,
        shippingClass: key === "B" ? "pallet" : "standard",
      },
    });
    let position = 0;
    for (const variant of variants) {
      await tx.productVariant.create({
        data: {
          productId: product.id,
          sku: variant.sku,
          price: variant.price,
          salePrice: variant.salePrice ?? null,
          ean: variant.ean ?? null,
          warrantyMonths: variant.warrantyMonths ?? null,
          weightGrams: variant.weightGrams ?? null,
          isDefault: position === 0,
          position: position++,
          costPrice: COST_SENTINEL,
          costPriceDate: new Date(),
        },
      });
    }
    let first = true;
    for (const categoryId of over.categories ?? []) {
      await tx.productCategory.create({
        data: { productId: product.id, categoryId, isPrimary: first },
      });
      first = false;
    }
    return { id: product.id, skus: variants.map((v) => v.sku) };
  };

  const a = await make("A", {
    title: `Pompă „Aqua” 100 – ț, ș, ă, â, î ${tag}`,
    subtitle: 'Silențioasă; clasa "A"',
    description: `Linia întâi, cu virgulă, punct și virgulă; și ghilimele "duble".\nLinia a doua.\n\nPaginile a treia: 100% eficient.`,
    brandId: brand.id,
    categories: [child.id, other.id],
    variants: [
      {
        sku: `A-${tag}`,
        price: 129_950,
        salePrice: 99_900,
        ean: "0012345678905",
        warrantyMonths: 24,
        weightGrams: 4200,
      },
    ],
  });
  const b = await make("B", {
    status: "draft",
    variants: [
      { sku: `B1-${tag}`, price: 10_000 },
      { sku: `B2-${tag}`, price: 15_050, ean: "5901234123457" },
    ],
  });
  const c = await make("C", { status: "archived" });
  const d = await make("D", { deletedAt: new Date(), status: "active" });
  return { parent, child, other, brand, a, b, c, d };
}

async function drain(prepared: PreparedExport) {
  const rows: PreparedExport["headers"][] = [];
  for await (const row of prepared.rows) rows.push(row.map(cellToCsvText));
  return rows;
}

const csvBytes = (prepared: PreparedExport, rows: string[][]): Uint8Array =>
  new TextEncoder().encode(toCsv([prepared.headers, ...rows]));

describe("exportul de produse pe baza reală", () => {
  it("implicit exclude coșul de gunoi; câte un rând pe variantă; antetele sunt cele ale importului", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      const prepared = await exporter.prepare(manager, { format: "csv", scope: "all" });
      // A (1) + B (2) + C arhivat (1); D din coș e exclus
      expect(prepared.counts).toMatchObject({ rows: 4 });
      const rows = await drain(prepared);
      expect(rows).toHaveLength(4);
      const skuColumn = prepared.headers.indexOf("SKU");
      expect(rows.map((r) => r[skuColumn]).sort()).toEqual(
        [`A-${tag}`, `B1-${tag}`, `B2-${tag}`, `C-${tag}`].sort(),
      );
      expect(prepared.headers.slice(0, IMPORT_FIELD_KEYS.length)).toEqual([
        "SKU",
        "Titlu",
        "Subtitlu",
        "Descriere",
        "Adresă (slug)",
        "Preț (lei, cu TVA)",
        "Preț promoțional (lei, cu TVA)",
        "Categorii",
        "Brand",
        "EAN",
        "Garanție (luni)",
        "Greutate (g)",
        "Lungime (mm)",
        "Lățime (mm)",
        "Înălțime (mm)",
        "Clasă de livrare",
        "Stare",
        "Unitate de măsură",
        "Baza prețului",
        "Pas de vânzare",
        "Minim (pași)",
        "Denumire pas",
        "Mod conversie SmartBill",
        "Unitate SmartBill",
        "Raport SmartBill",
        "Stare stoc",
        "Termen livrare (zile)",
      ]);
      expect(prepared.headers.slice(IMPORT_FIELD_KEYS.length)).toEqual([
        "ID produs",
        "Modificat la",
      ]);
      expect(prepared.fileName).toMatch(/^export-produse-\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });

  it("cu includeTrash apar și produsele din coș; selecția exportă exact ce s-a ales, și din coș", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      const manager = await as("manager");
      const base = await catalog(tx, tag);
      const withTrash = await exporter.prepare(manager, {
        format: "csv",
        scope: "all",
        includeTrash: true,
      });
      expect(withTrash.counts.rows).toBe(5);
      await drain(withTrash);

      const selection = await exporter.prepare(manager, {
        format: "csv",
        scope: "selection",
        ids: [base.d.id, base.a.id],
      });
      const rows = await drain(selection);
      const skuColumn = selection.headers.indexOf("SKU");
      expect(rows.map((r) => r[skuColumn]).sort()).toEqual([`A-${tag}`, `D-${tag}`].sort());
    });
  });

  it("filtrele curente: aceleași produse ca în listă (stare, categorie cu subcategorii, brand, coș)", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      const manager = await as("manager");
      const base = await catalog(tx, tag);
      const skus = async (filters: Record<string, string>, includeTrash = false) => {
        const prepared = await exporter.prepare(manager, {
          format: "csv",
          scope: "filters",
          filters,
          includeTrash,
        });
        const rows = await drain(prepared);
        const column = prepared.headers.indexOf("SKU");
        return rows.map((r) => r[column]).sort();
      };
      expect(await skus({ status: "draft" })).toEqual([`B1-${tag}`, `B2-${tag}`]);
      expect(await skus({ status: "archived" })).toEqual([`C-${tag}`]);
      // categoria-părinte include subcategoria
      expect(await skus({ category: base.parent.id })).toEqual([`A-${tag}`]);
      expect(await skus({ brand: base.brand.id })).toEqual([`A-${tag}`]);
      expect(await skus({ shipping: "pallet" })).toEqual([`B1-${tag}`, `B2-${tag}`]);
      // căutare după SKU de variantă
      expect(await skus({ q: `B2-${tag}` })).toEqual([`B1-${tag}`, `B2-${tag}`]);
      // vederea coșului de gunoi
      expect(await skus({ view: "deleted" })).toEqual([`D-${tag}`]);
      // chei necunoscute în filtre (inclusiv încercări de sortare după cost) se refuză
      await expect(
        exporter.prepare(manager, {
          format: "csv",
          scope: "filters",
          filters: { sort: "cost_desc" },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_INVALID" });
    });
  });

  it("limita de rânduri refuză cu mesaj; domeniul gol și cererea invalidă la fel", async () => {
    await withExport(async ({ tx, exporter, as, setMaxRows, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      setMaxRows(3);
      await expect(
        exporter.prepare(manager, { format: "csv", scope: "all" }),
      ).rejects.toMatchObject({
        code: "EXPORT_TOO_MANY_ROWS",
        message: expect.stringContaining("limita este 3"),
      });
      setMaxRows(20_000);
      await expect(
        exporter.prepare(manager, { format: "csv", scope: "selection", ids: [] }),
      ).rejects.toMatchObject({ code: "EXPORT_EMPTY" });
      await expect(
        exporter.prepare(manager, {
          format: "csv",
          scope: "filters",
          filters: { q: "nu-exista-niciun-produs-asa" },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_EMPTY" });
      await expect(
        exporter.prepare(manager, { format: "pdf", scope: "all" }),
      ).rejects.toMatchObject({ code: "EXPORT_INVALID" });
      await expect(
        exporter.prepare(manager, { format: "csv", scope: "all", costPrice: true }),
      ).rejects.toMatchObject({ code: "EXPORT_INVALID" });
    });
  });

  it("doar rolurile cu products.export pot exporta; Depozit, Editor, Suport și vizitatorul nu", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      await catalog(tx, tag);
      for (const role of ["manager", "admin", "owner"]) {
        const subject = await as(role);
        const prepared = await exporter.prepare(subject, { format: "csv", scope: "all" });
        await drain(prepared);
      }
      for (const role of ["warehouse", "editor", "support", "accountant"]) {
        const subject = await as(role);
        await expect(
          exporter.prepare(subject, { format: "csv", scope: "all" }),
        ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      }
      await expect(exporter.prepare(null, { format: "csv", scope: "all" })).rejects.toMatchObject({
        code: "AUTH_UNAUTHENTICATED",
      });
    });
  });

  it("prețul de achiziție nu apare nicăieri: nici în CSV, nici în XLSX (valoare-santinelă), nici în antete", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      // sanity: costul chiar există în baza de date
      expect(
        await tx.productVariant.count({ where: { costPrice: COST_SENTINEL } }),
      ).toBeGreaterThanOrEqual(5);

      const csv = await exporter.prepare(manager, {
        format: "csv",
        scope: "all",
        includeTrash: true,
      });
      const rows = await drain(csv);
      const text = toCsv([csv.headers, ...rows]);
      for (const form of COST_FORMS) expect(text, form).not.toContain(form);
      expect(csv.headers.some((h) => isCostLikeHeader(h))).toBe(false);

      const xlsx = await exporter.prepare(manager, {
        format: "xlsx",
        scope: "all",
        includeTrash: true,
      });
      const bytes = await buildExportXlsx(xlsx);
      const decoded = Object.values(unzipSync(bytes))
        .map((entry) => new TextDecoder().decode(entry))
        .join("\n");
      for (const form of COST_FORMS) expect(decoded, form).not.toContain(form);
      expect(xlsx.headers.some((h) => isCostLikeHeader(h))).toBe(false);
    });
  });

  it("un singur eveniment de audit product.export, doar cu numere; abandonul se înregistrează ca eșuat", async () => {
    await withExport(async ({ tx, exporter, as, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      const prepared = await exporter.prepare(manager, { format: "csv", scope: "all" });
      await drain(prepared);
      const events = await tx.auditLog.findMany({
        where: { action: "product.export", actorId: manager?.userId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "success", entity: "product_export" });
      expect(events[0]?.after).toMatchObject({
        format: "csv",
        scope: "all",
        rows: 4,
        products: 3,
        includeTrash: false,
      });
      // fără valori din catalog
      const serialized = JSON.stringify(events[0]);
      expect(serialized).not.toContain(tag);
      expect(serialized).not.toContain("Pompă");

      // clientul întrerupe descărcarea după primul rând
      const aborted = await exporter.prepare(manager, { format: "csv", scope: "all" });
      const iterator = aborted.rows[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.(undefined);
      const after = await tx.auditLog.findMany({
        where: { action: "product.export", actorId: manager?.userId },
        orderBy: { createdAt: "asc" },
      });
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ outcome: "failed" });
      expect(after[1]?.after).toMatchObject({ reason: "interrupted", rows: 1 });
    });
  });

  it("dus-întors CSV: exportul reimportat fără mapare manuală dă tot «neschimbat»", async () => {
    await withExport(async ({ tx, exporter, importer, as, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      const prepared = await exporter.prepare(manager, {
        format: "csv",
        scope: "all",
        includeTrash: true,
      });
      const rows = await drain(prepared);
      const file = { bytes: csvBytes(prepared, rows), fileName: "export.csv" };

      const analysis = await importer.register(manager, file);
      expect(analysis).toMatchObject({
        format: "csv",
        delimiter: ";",
        delimiterSource: "sep-line",
      });
      // maparea propusă: toate câmpurile importului, apoi cele două coloane doar pentru citire, ignorate
      expect(analysis.columns.map((c) => c.field)).toEqual([...IMPORT_FIELD_KEYS, null, null]);
      expect(analysis.columns.slice(-2).map((c) => c.blocked)).toEqual(["readonly", "readonly"]);

      const validation = await importer.validate(manager, {
        importId: analysis.importId,
        columns: analysis.columns.map((c) => c.field),
      });
      // 5 rânduri: A, B1, B2 → neschimbat; C arhivat și D din coș → ignorat; nimic nou, nimic actualizat
      expect(validation.report.counts).toEqual({
        new: 0,
        updated: 0,
        unchanged: 3,
        skipped: 2,
        errors: 0,
        warnings: 2,
      });
    });
  });

  it("dus-întors cu configurare de vânzare reală: unitate, pas, suprascrieri pe variantă, conversie SmartBill, negestionat, digital → tot «neschimbat», iar celulele exportate sunt cele efective", async () => {
    await withExport(async ({ tx, exporter, importer, as, tag }) => {
      const manager = await as("manager");
      const mp = await tx.measureUnit.create({
        data: { code: `mp_${tag}`, name: `Metru pătrat ${tag}`, symbol: `mp${tag}`, decimals: 2 },
      });
      // o a doua unitate cu ACELAȘI simbol: simbolul e ambiguu, deci exportul scrie codul unității (altfel nu s-ar reimporta)
      await tx.measureUnit.create({
        data: {
          code: `mp2_${tag}`,
          name: `Alt metru pătrat ${tag}`,
          symbol: `mp${tag}`,
          decimals: 2,
        },
      });
      const product = (key: string, data: Record<string, unknown> = {}) =>
        tx.product.create({
          data: {
            slug: `exp-s-${key.toLowerCase()}-${tag}`,
            title: `Vânzare ${key} ${tag}`,
            status: "active",
            ...data,
          },
        });
      const variant = (
        productId: string,
        sku: string,
        position: number,
        data: Record<string, unknown> = {},
      ) =>
        tx.productVariant.create({
          data: { productId, sku, price: 8_735, position, isDefault: position === 0, ...data },
        });
      // P1: liner (unitate și pas pe produs, denumire), a doua variantă cu pasul ei; conversie SmartBill pe prima
      const p1 = await product("P1", {
        measureUnitId: mp.id,
        saleStep: 412_500,
        saleStepLabel: "rolă",
        minSteps: 2,
        leadTimeDays: 9,
      });
      await variant(p1.id, `P1A-${tag}`, 0, {
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        smartbillUnitName: "rola",
      });
      await variant(p1.id, `P1B-${tag}`, 1, { saleStep: 825_000 });
      // P2: negestionat «La comandă», pe pas
      const p2 = await product("P2", {
        manageStock: false,
        stockStatus: "onbackorder",
        priceBasis: "step",
      });
      await variant(p2.id, `P2A-${tag}`, 0);
      // P3: digital negestionat (starea nu se exportă)
      const p3 = await product("P3", {
        type: "digital",
        manageStock: false,
        stockStatus: "outofstock",
      });
      await variant(p3.id, `P3A-${tag}`, 0);
      // P4: la bucată, nimic setat
      const p4 = await product("P4");
      await variant(p4.id, `P4A-${tag}`, 0);

      const prepared = await exporter.prepare(manager, { format: "csv", scope: "all" });
      const rows = await drain(prepared);
      const at = (sku: string, label: string): string | undefined => {
        const row = rows.find((r) => r[prepared.headers.indexOf("SKU")] === sku);
        return row?.[prepared.headers.indexOf(label)];
      };
      // valorile EFECTIVE ale fiecărei variante
      expect(at(`P1A-${tag}`, "Unitate de măsură")).toBe(`mp_${tag}`);
      expect(at(`P1A-${tag}`, "Pas de vânzare")).toBe("41,25");
      expect(at(`P1B-${tag}`, "Pas de vânzare")).toBe("82,5");
      expect(at(`P1B-${tag}`, "Minim (pași)")).toBe("2");
      expect(at(`P1A-${tag}`, "Denumire pas")).toBe("rolă");
      expect(at(`P1A-${tag}`, "Mod conversie SmartBill")).toBe("Raport");
      expect(at(`P1A-${tag}`, "Raport SmartBill")).toBe("41,25");
      expect(at(`P1B-${tag}`, "Mod conversie SmartBill")).toBe("");
      expect(at(`P1A-${tag}`, "Termen livrare (zile)")).toBe("9");
      expect(at(`P1A-${tag}`, "Stare stoc")).toBe("");
      expect(at(`P2A-${tag}`, "Baza prețului")).toBe("Pe pas");
      expect(at(`P2A-${tag}`, "Stare stoc")).toBe("La comandă");
      expect(at(`P3A-${tag}`, "Stare stoc")).toBe("");
      expect(at(`P4A-${tag}`, "Unitate de măsură")).toBe("buc");
      expect(at(`P4A-${tag}`, "Pas de vânzare")).toBe("1");

      const file = { bytes: csvBytes(prepared, rows), fileName: "export.csv" };
      const analysis = await importer.register(manager, file);
      const validation = await importer.validate(manager, {
        importId: analysis.importId,
        columns: analysis.columns.map((c) => c.field),
      });
      expect(validation.report.counts).toMatchObject({ new: 0, updated: 0, errors: 0 });
      expect(validation.report.counts.unchanged).toBe(5);
    });
  });

  it("dus-întors XLSX: la fel, cu SKU și EAN ca text (zerourile se păstrează) și prețuri numerice", async () => {
    await withExport(async ({ tx, exporter, importer, as, tag }) => {
      const manager = await as("manager");
      await catalog(tx, tag);
      const prepared = await exporter.prepare(manager, { format: "xlsx", scope: "all" });
      expect(prepared.fileName).toMatch(/\.xlsx$/);
      const bytes = await buildExportXlsx(prepared);

      const analysis = await importer.register(manager, { bytes, fileName: "export.xlsx" });
      expect(analysis.format).toBe("xlsx");
      expect(analysis.columns.map((c) => c.field)).toEqual([...IMPORT_FIELD_KEYS, null, null]);
      const eanIndex = analysis.headers.indexOf("EAN");
      const priceIndex = analysis.headers.indexOf("Preț (lei, cu TVA)");
      const eans = analysis.sample.map((r) => r[eanIndex]);
      expect(eans).toContain("0012345678905"); // zerourile de la început rămân
      expect(analysis.sample.map((r) => r[priceIndex])).toEqual(
        expect.arrayContaining(["1299.5", "100", "150.5"]),
      );

      const validation = await importer.validate(manager, {
        importId: analysis.importId,
        columns: analysis.columns.map((c) => c.field),
      });
      // A, B1, B2, C (arhivat → ignorat); D e exclus (nu s-a cerut coșul)
      expect(validation.report.counts).toMatchObject({
        new: 0,
        updated: 0,
        unchanged: 3,
        skipped: 1,
        errors: 0,
      });
    });
  });

  it("neutralizarea formulelor merge dus-întors: textele cu =, +, -, @ și apostrof rămân neschimbate", async () => {
    await withExport(async ({ tx, exporter, importer, as, tag }) => {
      const manager = await as("manager");
      const base = await catalog(tx, tag);
      const trap = await tx.product.create({
        data: {
          slug: `exp-trap-${tag}`,
          title: `=HYPERLINK("http://exemplu.invalid";"click") ${tag}`,
          subtitle: "-5°C până la +40°C",
          description: "@utilizator a scris: -1 + 1 = 0",
          status: "active",
          brandId: base.brand.id,
        },
      });
      await tx.productVariant.create({
        data: {
          productId: trap.id,
          sku: `T-${tag}`,
          price: 5_000,
          isDefault: true,
          costPrice: COST_SENTINEL,
        },
      });
      const lone = await tx.product.create({
        data: {
          slug: `exp-lone-${tag}`,
          title: `'=deja-cu-apostrof ${tag}`,
          subtitle: "-",
          status: "draft",
        },
      });
      await tx.productVariant.create({
        data: { productId: lone.id, sku: `L-${tag}`, price: 5_000, isDefault: true },
      });

      for (const format of ["csv", "xlsx"] as const) {
        const prepared = await exporter.prepare(manager, {
          format,
          scope: "selection",
          ids: [trap.id, lone.id],
        });
        let bytes: Uint8Array;
        if (format === "csv") {
          const rows = await drain(prepared);
          bytes = csvBytes(prepared, rows);
          const text = new TextDecoder().decode(bytes);
          // în fișier textele periculoase au apostrof în față (nu încep cu = + - @)
          expect(text).toContain(`'=HYPERLINK`);
          expect(text).toContain(`'-5°C`);
          expect(text).toContain(`'@utilizator`);
          expect(text).toContain(`''=deja-cu-apostrof`);
          expect(text).not.toMatch(/(^|;|\r\n)=HYPERLINK/);
        } else {
          bytes = await buildExportXlsx(prepared);
        }
        const analysis = await importer.register(manager, {
          bytes,
          fileName: format === "csv" ? "e.csv" : "e.xlsx",
        });
        const validation = await importer.validate(manager, {
          importId: analysis.importId,
          columns: analysis.columns.map((c) => c.field),
        });
        // titlul, subtitlul și descrierea restaurate exact: nimic de actualizat; «-» din subtitlu NU șterge
        expect(validation.report.counts, format).toMatchObject({
          new: 0,
          updated: 0,
          unchanged: 2,
          errors: 0,
        });
      }
      const afterLone = await tx.product.findUniqueOrThrow({ where: { id: lone.id } });
      expect(afterLone.subtitle).toBe("-");
    });
  });
});
