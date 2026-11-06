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
import {
  StockActivationService,
  type ActivationApplyInput,
  type StockActivationPreview,
} from "./stock-activation";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 12e: pornirea în masă a gestionării în timp ce comenzile rezervă stoc pe aceleași variante, aplicări
 * simultane ale aceluiași fișier și dimensiunea tranzacției pentru ~1.600 de produse (date COMISE, conexiuni separate,
 * depozit propriu). Scrise înaintea serviciului. Într-un fișier propriu, ca la `stock-concurrency`.
 */
const db = getDb();
// Spațiul de nume al fișierului (date comise): curățarea resturilor șterge doar ce are acest prefix, nu și datele altui fișier
// rulat în paralel (15e; unic pe fișier, păzit de testul de arhitectură `stock-fixtures-namespace`).
const STOCK_NAMESPACE = "sact";

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
const WAREHOUSE = "Gestiune Pornire";
const NOW = new Date("2099-01-01T12:00:00Z");
const TAKEN = new Date("2099-01-01T11:00:00Z");

describe("pornirea gestionării pe date comise", () => {
  afterAll(async () => {
    await purgeStockLeftovers(db, STOCK_NAMESPACE);
  });

  async function withCommitted<T>(fn: (ctx: StockContext) => Promise<T>): Promise<T> {
    await purgeStockLeftovers(db, STOCK_NAMESPACE);
    const ctx = await createStockContext(db, { namespace: STOCK_NAMESPACE });
    try {
      return await fn(ctx);
    } finally {
      await purgeStockContext(db, ctx);
    }
  }

  const service = (ctx: StockContext, extra: { maxVariants?: number } = {}) =>
    new StockActivationService({
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
      ...extra,
    });

  const fileOf = (rows: FabricatedRow[]): Uint8Array =>
    new Uint8Array(buildReport({ format: "xlsx", dateText: "Data: 01.01.2099", rows }));

  const applyInput = (
    bytes: Uint8Array,
    preview: StockActivationPreview,
    startUnmatched = false,
  ): ActivationApplyInput => ({
    bytes,
    fileName: "raport.xlsx",
    takenAt: TAKEN,
    planHash: preview.planHash as string,
    acknowledgeTimeWarnings: false,
    startUnmatched,
    confirm: {
      products: preview.counters?.products ?? 0,
      variants: preview.counters?.matched ?? 0,
      zero: preview.counters?.zero ?? 0,
    },
  });

  async function unmanagedProducts(ctx: StockContext, count: number) {
    const out: Array<{ productId: string; id: string; sku: string }> = [];
    for (let i = 0; i < count; i += 1) {
      const created = await addStockProduct(db, ctx, {
        manageStock: false,
        variants: [{ physical: null }],
      });
      out.push({
        productId: created.productId,
        ...(created.variants[0] as { id: string; sku: string }),
      });
    }
    return out;
  }

  it("fără fereastra «Indisponibil»: rezervările simultane văd variantele fie negestionate, fie gestionate CU stoc", async () => {
    await withCommitted(async (ctx) => {
      const stock = new StockService({ db });
      const items = await unmanagedProducts(ctx, 40);
      const bytes = fileOf(
        items.map((i) => ({ warehouse: WAREHOUSE, code: i.sku, unit: "BUC", quantity: 10 })),
      );
      const activation = service(ctx);
      const preview = await activation.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.canApply).toBe(true);

      const work = [
        activation.apply(owner, applyInput(bytes, preview)),
        ...items.map((i, n) =>
          stock.reserve(
            { refType: "order", refId: `${ctx.tag}-r${n}` },
            [{ variantId: i.id, warehouseId: ctx.warehouseId, quantity: q("1") }],
            new Date(Date.now() + 600_000),
          ),
        ),
      ];
      const settled = await Promise.allSettled(work);
      // nicio rezervare nu se oprește pe «stoc insuficient» (varianta gestionată, dar fără stoc)
      expect(
        settled
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      const outcomes = settled
        .slice(1)
        .flatMap((r) =>
          r.status === "fulfilled"
            ? (r.value as Array<{ outcome: string }>).map((o) => o.outcome)
            : [],
        );
      expect(outcomes).toHaveLength(40);
      for (const outcome of outcomes) {
        expect(["skipped_unmanaged", "reserved"]).toContain(outcome);
      }
      for (const item of items) {
        const row = await db.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: item.id, warehouseId: ctx.warehouseId } },
        });
        expect(row.physical).toBe(q("10"));
        expect((await stock.checkConsistency(item.id, ctx.warehouseId)).ok).toBe(true);
      }
      const snapshot = await db.stockSnapshot.findFirst({
        where: { warehouseId: ctx.warehouseId },
      });
      if (snapshot) ctx.snapshotIds.push(snapshot.id);
    });
  }, 90_000);

  it("trei aplicări simultane ale aceluiași fișier: una reușește, celelalte sunt refuzate, o singură poză", async () => {
    await withCommitted(async (ctx) => {
      const items = await unmanagedProducts(ctx, 10);
      const bytes = fileOf(
        items.map((i) => ({ warehouse: WAREHOUSE, code: i.sku, unit: "BUC", quantity: 7 })),
      );
      const activation = service(ctx);
      const preview = await activation.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      const input = applyInput(bytes, preview);
      const results = await Promise.allSettled([
        activation.apply(owner, input),
        activation.apply(owner, input),
        activation.apply(owner, input),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: expect.stringMatching(
            /^STOCK_(IMPORT_(NOT_NEWER|PLAN_CHANGED)|ACTIVATION_NOTHING_TO_ENABLE)$/,
          ),
        });
      }
      expect(await db.stockSnapshot.count({ where: { warehouseId: ctx.warehouseId } })).toBe(1);
      for (const item of items) {
        const row = await db.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: item.id, warehouseId: ctx.warehouseId } },
        });
        expect(row.physical).toBe(q("7"));
        expect(
          (await db.product.findUniqueOrThrow({ where: { id: item.productId } })).manageStock,
        ).toBe(true);
      }
      const snapshot = await db.stockSnapshot.findFirst({
        where: { warehouseId: ctx.warehouseId },
      });
      if (snapshot) ctx.snapshotIds.push(snapshot.id);
    });
  }, 90_000);

  it("~1.600 de produse (și 100 de variante fără potrivire, la 0) într-o singură tranzacție: se pornesc toate, în timp rezonabil", async () => {
    await withCommitted(async (ctx) => {
      const matched = 1600;
      const extra = 100;
      const items = await unmanagedProducts(ctx, matched + extra);
      const inFile = items.slice(0, matched);
      const bytes = fileOf(
        inFile.map((i, n) => ({
          warehouse: WAREHOUSE,
          code: i.sku,
          unit: "BUC",
          quantity: (n % 50) + 1,
        })),
      );
      const activation = service(ctx);
      const preview = await activation.preview(owner, {
        bytes,
        fileName: null,
        takenAt: TAKEN,
        startUnmatched: true,
      });
      expect(preview.counters).toMatchObject({ products: matched + extra, matched, zero: extra });
      expect(preview.canApply).toBe(true);
      const started = Date.now();
      const result = await activation.apply(owner, applyInput(bytes, preview, true));
      const elapsed = Date.now() - started;
      ctx.snapshotIds.push(result.snapshotId);
      expect(result).toMatchObject({
        enabledProducts: matched + extra,
        enabledVariants: matched,
        startedAtZero: extra,
        applied: matched + extra,
      });
      expect(
        await db.product.count({
          where: { id: { in: items.map((i) => i.productId) }, manageStock: true },
        }),
      ).toBe(matched + extra);
      expect(
        await db.inventoryItem.count({
          where: { warehouseId: ctx.warehouseId, physicalAsOf: TAKEN },
        }),
      ).toBe(matched + extra);
      // aplicarea (o tranzacție) rămâne mult sub timpul maxim al tranzacției (300 s)
      expect(elapsed).toBeLessThan(120_000);
    });
  }, 400_000);
});
