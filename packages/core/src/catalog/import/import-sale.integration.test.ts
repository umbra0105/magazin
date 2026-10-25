import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
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

/**
 * Faza 5, punctul 9b: coloanele de vânzare la import, pe baza reală (tranzacție anulată): produse noi create NEGESTIONATE
 * explicit, unitate, pas și stare aplicate pe produs sau pe variantă după regula uniform/diferit/parțial, conversia
 * SmartBill pe variantă, «Stare stoc» doar la negestionate, cu verificări pe configurația efectivă.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
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

async function withImport<T>(
  fn: (c: {
    tx: TestTx;
    service: ReturnType<typeof createProductImportService>;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
    tag: string;
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
          // magazinul are gestiunea PORNITĂ implicit: importul trebuie să creeze totuși produse negestionate
          if (group === "inventory") return { manageStock: true };
          if (group === "catalog") return { defaultWarrantyMonths: 24 };
          throw new Error(`grup neașteptat: ${group}`);
        },
      } as never,
      audit: new AuditService(createPrismaAuditStore(tx)),
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `isl-${role}-${n++}`, name: role, email: `isl-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, as, tag: uid() });
  });
}

const file = (rows: string[][]) => ({
  bytes: new TextEncoder().encode(rows.map((r) => r.join(";")).join("\r\n") + "\r\n"),
  fileName: "import.csv",
});

type Service = Parameters<Parameters<typeof withImport>[0]>[0]["service"];
type Subject = Awaited<ReturnType<Parameters<Parameters<typeof withImport>[0]>[0]["as"]>>;

/** Verifică și aplică un fișier; întoarce raportul verificării. */
async function importFile(
  service: Service,
  subject: Subject,
  rows: string[][],
  columns: (string | null)[],
) {
  const analysis = await service.register(subject, file(rows));
  const validation = await service.validate(subject, { importId: analysis.importId, columns });
  await service.apply(subject, {
    importId: analysis.importId,
    confirm: true,
    expectedPlanHash: validation.planHash,
  });
  return validation.report;
}

async function unit(tx: TestTx, tag: string, symbol: string, decimals: number) {
  return tx.measureUnit.create({
    data: {
      code: `${symbol}_${tag}`,
      name: `Unitate ${symbol} ${tag}`,
      symbol: `${symbol}${tag}`,
      decimals,
    },
  });
}

async function productWith(
  tx: TestTx,
  tag: string,
  key: string,
  variantSkus: string[],
  data: Record<string, unknown> = {},
) {
  const product = await tx.product.create({
    data: { slug: `isl-${key}-${tag}`, title: `Produs ${key} ${tag}`, ...data },
  });
  const variants = [];
  for (const [position, sku] of variantSkus.entries()) {
    variants.push(
      await tx.productVariant.create({
        data: { productId: product.id, sku, price: 10_000, position, isDefault: position === 0 },
      }),
    );
  }
  return { product, variants };
}

describe("produse noi din import", () => {
  it("se creează NEGESTIONATE (explicit), cu unitatea, pasul, starea și termenul din fișier; conversia SmartBill pe variantă", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const mp = await unit(tx, tag, "mp", 2);
      const report = await importFile(
        service,
        manager,
        [
          [
            "SKU",
            "Titlu",
            "Preț",
            "Unitate de măsură",
            "Pas de vânzare",
            "Denumire pas",
            "Mod conversie SmartBill",
            "Raport SmartBill",
            "Stare stoc",
            "Termen livrare (zile)",
          ],
          [
            `NEW-${tag}`,
            "Liner nou",
            "87,35",
            `mp${tag}`,
            "41,25",
            "rolă",
            "Raport",
            "41,25",
            "La comandă",
            "7",
          ],
          [`PLAIN-${tag}`, "Simplu", "10,00", "", "", "", "", "", "", ""],
        ],
        [
          "sku",
          "title",
          "price",
          "unit",
          "saleStep",
          "saleStepLabel",
          "smartbillMode",
          "smartbillRatio",
          "stockStatus",
          "leadTimeDays",
        ],
      );
      expect(report.counts).toMatchObject({ new: 2, errors: 0 });

      const liner = await tx.productVariant.findFirstOrThrow({
        where: { sku: `NEW-${tag}` },
        include: { product: true },
      });
      expect(liner.product).toMatchObject({
        manageStock: false,
        measureUnitId: mp.id,
        saleStep: 412_500,
        saleStepLabel: "rolă",
        stockStatus: "onbackorder",
        leadTimeDays: 7,
        priceBasis: "unit",
      });
      expect(liner).toMatchObject({
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        measureUnitId: null,
        saleStep: null,
      });
      // negestionat: niciun rând de stoc
      expect(await tx.inventoryItem.count({ where: { variantId: liner.id } })).toBe(0);

      const plain = await tx.productVariant.findFirstOrThrow({
        where: { sku: `PLAIN-${tag}` },
        include: { product: true },
      });
      expect(plain.product).toMatchObject({
        manageStock: false,
        stockStatus: "instock",
        measureUnitId: null,
      });
    });
  });

  it("erori pe rând, nimic creat: unitate necunoscută, pas cu prea multe zecimale, raport inexact", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      await unit(tx, tag, "mp", 2);
      const before = await tx.product.count();
      const analysis = await service.register(
        manager,
        file([
          [
            "SKU",
            "Titlu",
            "Preț",
            "Unitate de măsură",
            "Pas de vânzare",
            "Mod conversie SmartBill",
            "Raport SmartBill",
          ],
          [`E1-${tag}`, "A", "1", "litri", "", "", ""],
          [`E2-${tag}`, "B", "1", `mp${tag}`, "2,033", "", ""],
          [`E3-${tag}`, "C", "1", `mp${tag}`, "2,03", "Raport", "0,3"],
        ]),
      );
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: ["sku", "title", "price", "unit", "saleStep", "smartbillMode", "smartbillRatio"],
      });
      expect(validation.report.counts).toMatchObject({ new: 0, errors: 3 });
      expect(await tx.product.count()).toBe(before);
    });
  });
});

describe("produse existente: pe produs sau pe variantă", () => {
  it("aceeași valoare la toate variantele → pe produs (suprascrierile se golesc); valori diferite → pe variantă", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const ml = await unit(tx, tag, "ml", 1);
      const uniform = await productWith(tx, tag, "uni", [`U1-${tag}`, `U2-${tag}`], {
        measureUnitId: ml.id,
      });
      await tx.productVariant.update({
        where: { id: uniform.variants[0]!.id },
        data: { saleStep: 15_000 },
      });
      const varied = await productWith(tx, tag, "var", [`V1-${tag}`, `V2-${tag}`], {
        measureUnitId: ml.id,
      });

      const report = await importFile(
        service,
        manager,
        [
          ["SKU", "Pas de vânzare"],
          [`U1-${tag}`, "2,5"],
          [`U2-${tag}`, "2,5"],
          [`V1-${tag}`, "1,5"],
          [`V2-${tag}`, "1,8"],
        ],
        ["sku", "saleStep"],
      );
      expect(report.counts).toMatchObject({ updated: 4, errors: 0 });

      const u = await tx.product.findUniqueOrThrow({
        where: { id: uniform.product.id },
        include: { variants: { orderBy: { position: "asc" } } },
      });
      expect(u.saleStep).toBe(25_000);
      expect(u.variants.map((v) => v.saleStep)).toEqual([null, null]);

      const v = await tx.product.findUniqueOrThrow({
        where: { id: varied.product.id },
        include: { variants: { orderBy: { position: "asc" } } },
      });
      expect(v.saleStep).toBeNull();
      expect(v.variants.map((x) => x.saleStep)).toEqual([15_000, 18_000]);
    });
  });

  it("fișier parțial (o variantă din două): se scrie pe variantă, cealaltă variantă rămâne neatinsă", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const mp = await unit(tx, tag, "mp", 2);
      const p = await productWith(tx, tag, "par", [`P1-${tag}`, `P2-${tag}`], {
        measureUnitId: mp.id,
        saleStep: 20_300,
      });
      await importFile(
        service,
        manager,
        [
          ["SKU", "Pas de vânzare"],
          [`P1-${tag}`, "4,06"],
        ],
        ["sku", "saleStep"],
      );
      const after = await tx.product.findUniqueOrThrow({
        where: { id: p.product.id },
        include: { variants: { orderBy: { position: "asc" } } },
      });
      expect(after.saleStep).toBe(20_300);
      expect(after.variants.map((v) => v.saleStep)).toEqual([40_600, null]);
    });
  });

  it("«Stare stoc»: doar negestionate; la gestionate se ignoră cu avertisment și nu se modifică nimic", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const unmanaged = await productWith(tx, tag, "neg", [`N-${tag}`], { manageStock: false });
      const managed = await productWith(tx, tag, "ges", [`G-${tag}`], { manageStock: true });
      const analysis = await service.register(
        manager,
        file([
          ["SKU", "Stare stoc"],
          [`N-${tag}`, "Stoc epuizat"],
          [`G-${tag}`, "Stoc epuizat"],
        ]),
      );
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: ["sku", "stockStatus"],
      });
      expect(validation.report.counts).toMatchObject({
        updated: 1,
        unchanged: 1,
        errors: 0,
        warnings: 1,
      });
      await service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      expect(
        (await tx.product.findUniqueOrThrow({ where: { id: unmanaged.product.id } })).stockStatus,
      ).toBe("outofstock");
      expect(
        (await tx.product.findUniqueOrThrow({ where: { id: managed.product.id } })).stockStatus,
      ).toBe("instock");
    });
  });

  it("conversia SmartBill pe variantă; raportul care nu convertește exact pasul e refuzat în verificare, nimic scris", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const mp = await unit(tx, tag, "mp", 2);
      const ok = await productWith(tx, tag, "sb", [`SB-${tag}`], {
        measureUnitId: mp.id,
        saleStep: 412_500,
      });
      const bad = await productWith(tx, tag, "sbx", [`SX-${tag}`], {
        measureUnitId: mp.id,
        saleStep: 412_500,
      });
      const analysis = await service.register(
        manager,
        file([
          ["SKU", "Mod conversie SmartBill", "Unitate SmartBill", "Raport SmartBill"],
          [`SB-${tag}`, "Raport", "rola", "41,25"],
          [`SX-${tag}`, "Raport", "rola", "0,7"],
        ]),
      );
      const validation = await service.validate(manager, {
        importId: analysis.importId,
        columns: ["sku", "smartbillMode", "smartbillUnitName", "smartbillRatio"],
      });
      expect(validation.report.counts).toMatchObject({ updated: 1, errors: 1 });
      await service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      });
      expect(
        await tx.productVariant.findFirstOrThrow({ where: { id: ok.variants[0]!.id } }),
      ).toMatchObject({
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        smartbillUnitName: "rola",
      });
      expect(
        await tx.productVariant.findFirstOrThrow({ where: { id: bad.variants[0]!.id } }),
      ).toMatchObject({
        smartbillMode: null,
        smartbillRatio: null,
      });
    });
  });

  it("denumirea pasului și termenul se scriu pe produs și se pot șterge cu «-»", async () => {
    await withImport(async ({ tx, service, as, tag }) => {
      const manager = await as("manager");
      const a = await productWith(tx, tag, "etl", [`T1-${tag}`]);
      const b = await productWith(tx, tag, "etc", [`T2-${tag}`], {
        saleStepLabel: "x",
        leadTimeDays: 3,
      });
      await importFile(
        service,
        manager,
        [
          ["SKU", "Denumire pas", "Termen livrare (zile)"],
          [`T1-${tag}`, "sac", "10"],
          [`T2-${tag}`, "-", "-"],
        ],
        ["sku", "saleStepLabel", "leadTimeDays"],
      );
      expect(await tx.product.findUniqueOrThrow({ where: { id: a.product.id } })).toMatchObject({
        saleStepLabel: "sac",
        leadTimeDays: 10,
      });
      expect(await tx.product.findUniqueOrThrow({ where: { id: b.product.id } })).toMatchObject({
        saleStepLabel: null,
        leadTimeDays: null,
      });
    });
  });
});
