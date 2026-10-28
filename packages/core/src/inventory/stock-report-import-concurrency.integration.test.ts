import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, type Quantity } from "@ecom/shared";
import {
  buildReport,
  type FabricatedRow,
} from "../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { MemoryAudit } from "../test-utils/memory-audit";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockReportImportService } from "./stock-report-import";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 12c: importul «stoc la zi» în timp ce comenzile rezervă și angajează stoc pe aceleași variante (date
 * COMISE, conexiuni separate, depozit propriu). Într-un fișier propriu, ca la `stock-concurrency`. Importul blochează
 * rândurile în aceeași ordine ca rezervarea, deci nu apare deadlock, iar contoarele rămân coerente.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const owner: PermissionSubject = {
  userId: "user-owner",
  email: "owner@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};
const WAREHOUSE = "Gestiune Concurenta";
const NOW = new Date("2099-01-01T12:00:00Z");
const TAKEN = new Date("2099-01-01T11:00:00Z");

describe("import în timp ce se rezervă stoc (date comise)", () => {
  afterAll(async () => {
    await purgeStockLeftovers(db);
  });

  async function withCommitted<T>(fn: (ctx: StockContext) => Promise<T>): Promise<T> {
    await purgeStockLeftovers(db);
    const ctx = await createStockContext(db);
    try {
      return await fn(ctx);
    } finally {
      await purgeStockContext(db, ctx);
    }
  }

  const service = (ctx: StockContext) =>
    new StockReportImportService({
      db,
      warehouseId: ctx.warehouseId,
      audit: new AuditService(new MemoryAudit()),
      now: () => NOW,
      settings: {
        read: async () => ({
          warehouses: [WAREHOUSE],
          timeZone: "Europe/Bucharest",
          safetyWindowMinutes: 30,
        }),
        writeWarehouses: async (names) => names,
      },
    });

  const fileOf = (rows: FabricatedRow[]): Uint8Array =>
    new Uint8Array(buildReport({ format: "xlsx", dateText: "Data: 01.01.2099", rows }));

  it("40 de variante importate deodată cu 40 de rezervări și 20 de angajări în ordine amestecată: fără deadlock, contoare coerente", async () => {
    await withCommitted(async (ctx) => {
      const stock = new StockService({ db });
      const created = await addStockProduct(db, ctx, {
        variants: Array.from({ length: 40 }, () => ({ physical: "10" })),
      });
      const variants = created.variants;
      const bytes = fileOf(
        variants.map((v) => ({ warehouse: WAREHOUSE, code: v.sku, unit: "BUC", quantity: 20 })),
      );
      const importer = service(ctx);
      const preview = await importer.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.canApply).toBe(true);

      const reversed = [...variants].reverse();
      const work = [
        importer.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
          planHash: preview.planHash as string,
          acknowledgeTimeWarnings: false,
        }),
        ...variants.map((v, i) =>
          stock.reserve(
            { refType: "order", refId: `${ctx.tag}-r${i}` },
            [{ variantId: v.id, warehouseId: ctx.warehouseId, quantity: q("1") }],
            new Date(Date.now() + 600_000),
          ),
        ),
        ...reversed
          .slice(0, 20)
          .map((v, i) =>
            stock.commitDirect({ refType: "order", refId: `${ctx.tag}-c${i}` }, [
              { variantId: v.id, warehouseId: ctx.warehouseId, quantity: q("1") },
            ]),
          ),
      ];
      const settled = await Promise.allSettled(work);
      const failures = settled.filter((r) => r.status === "rejected");
      expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

      for (const [i, variant] of variants.entries()) {
        const row = await db.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: variant.id, warehouseId: ctx.warehouseId } },
        });
        // fizicul e cel din poză; rezervarea (1) a rămas; angajarea (1) a rămas sau a fost oglindită de poză
        expect(row.physical).toBe(q("20"));
        expect(row.reserved).toBe(q("1"));
        expect([0n, q("1")]).toContain(row.committed);
        expect(
          (await stock.checkConsistency(variant.id, ctx.warehouseId)).ok,
          `variantă ${i}`,
        ).toBe(true);
      }
      const snapshots = await db.stockSnapshot.count({ where: { warehouseId: ctx.warehouseId } });
      expect(snapshots).toBe(1);
      const first = await db.stockSnapshot.findFirst({ where: { warehouseId: ctx.warehouseId } });
      if (first) ctx.snapshotIds.push(first.id);
    });
  }, 60_000);

  it("două aplicări simultane ale aceluiași fișier: una reușește, cealaltă e refuzată, stocul rămâne al unei singure poze", async () => {
    await withCommitted(async (ctx) => {
      const created = await addStockProduct(db, ctx, {
        variants: Array.from({ length: 10 }, () => ({ physical: "0" })),
      });
      const bytes = fileOf(
        created.variants.map((v) => ({
          warehouse: WAREHOUSE,
          code: v.sku,
          unit: "BUC",
          quantity: 7,
        })),
      );
      const importer = service(ctx);
      const preview = await importer.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      const run = () =>
        importer.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
          planHash: preview.planHash as string,
          acknowledgeTimeWarnings: false,
        });
      const results = await Promise.allSettled([run(), run(), run()]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: expect.stringMatching(/^STOCK_IMPORT_(NOT_NEWER|PLAN_CHANGED)$/),
        });
      }
      expect(await db.stockSnapshot.count({ where: { warehouseId: ctx.warehouseId } })).toBe(1);
      for (const v of created.variants) {
        const row = await db.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: v.id, warehouseId: ctx.warehouseId } },
        });
        expect(row.physical).toBe(q("7"));
      }
      const snapshot = await db.stockSnapshot.findFirst({
        where: { warehouseId: ctx.warehouseId },
      });
      if (snapshot) ctx.snapshotIds.push(snapshot.id);
    });
  }, 60_000);

  it("~1.700 de variante într-o singură tranzacție: se aplică toate, în timp rezonabil", async () => {
    await withCommitted(async (ctx) => {
      const count = 1700;
      const created = await addStockProduct(db, ctx, {
        variants: Array.from({ length: count }, () => ({ physical: "1" })),
      });
      const bytes = fileOf(
        created.variants.map((v, i) => ({
          warehouse: WAREHOUSE,
          code: v.sku,
          unit: "BUC",
          quantity: (i % 50) + 1,
        })),
      );
      const importer = service(ctx);
      const preview = await importer.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.counters?.matched).toBe(count);
      const applyStarted = Date.now();
      const result = await importer.apply(owner, {
        bytes,
        fileName: "raport.xlsx",
        takenAt: TAKEN,
        planHash: preview.planHash as string,
        acknowledgeTimeWarnings: false,
      });
      const applyMs = Date.now() - applyStarted;
      ctx.snapshotIds.push(result.snapshotId);
      expect(result.applied).toBe(count);
      const total = await db.inventoryItem.count({
        where: { warehouseId: ctx.warehouseId, physicalAsOf: TAKEN },
      });
      expect(total).toBe(count);
      // aplicarea (o tranzacție) rămâne mult sub timpul maxim al tranzacției (300 s)
      expect(applyMs).toBeLessThan(120_000);
    });
  }, 240_000);
});
