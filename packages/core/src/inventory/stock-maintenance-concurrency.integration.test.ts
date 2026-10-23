import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { MemoryAudit } from "../test-utils/memory-audit";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockMaintenance } from "./stock-maintenance";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 7: idempotența mentenanței la instanțe simultane, pe date COMISE și conexiuni separate. Într-un fișier
 * propriu, ca la stoc (`stock-concurrency`): testele cu tranzacție anulată și cele cu date comise nu se amestecă.
 * Datele create se șterg la sfârșitul fiecărui test; resturile unei rulări întrerupte, la începutul lui.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const days = (base: Date, n: number): Date => new Date(base.getTime() + n * 86_400_000);

describe("două instanțe deodată (date comise, conexiuni separate)", () => {
  const pool = db;
  afterAll(async () => {
    await purgeStockLeftovers(pool);
  });

  async function withCommitted<T>(fn: (ctx: StockContext) => Promise<T>): Promise<T> {
    await purgeStockLeftovers(pool);
    const ctx = await createStockContext(pool);
    try {
      return await fn(ctx);
    } finally {
      await purgeStockContext(pool, ctx);
    }
  }

  it("4 instanțe expiră deodată 50 de rezervări: fiecare expiră o singură dată, contoarele rămân coerente", async () => {
    await withCommitted(async (ctx) => {
      const service = new StockService({ db: pool });
      const created = await addStockProduct(pool, ctx, {
        variants: Array.from({ length: 50 }, () => ({ physical: "5" })),
      });
      const soon = new Date(Date.now() + 4_000);
      for (const [i, variant] of created.variants.entries()) {
        await service.reserve(
          { refType: "order", refId: `${ctx.tag}-${i}` },
          [{ variantId: variant.id, warehouseId: ctx.warehouseId, quantity: q("2") }],
          soon,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, soon.getTime() - Date.now()) + 200),
      );
      const runs = await Promise.all(
        Array.from({ length: 4 }, () =>
          new StockMaintenance({
            db: pool,
            audit: new AuditService(new MemoryAudit()),
            batchSize: 7,
          }).expireReservations(),
        ),
      );
      expect(runs.reduce((sum, r) => sum + r.expired, 0)).toBe(50);
      for (const variant of created.variants) {
        const row = await pool.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId: variant.id, warehouseId: ctx.warehouseId } },
        });
        expect(row.reserved).toBe(0n);
        expect((await service.checkConsistency(variant.id, ctx.warehouseId)).ok).toBe(true);
      }
      expect(
        await pool.stockReservation.count({
          where: { variantId: { in: created.variants.map((v) => v.id) }, status: "expired" },
        }),
      ).toBe(50);
    });
  });

  it("4 instanțe verifică prospețimea deodată (cu audit lent): exact o alertă, celelalte văd că altcineva lucrează", async () => {
    await withCommitted(async (ctx) => {
      await addStockProduct(pool, ctx, { variants: [{ physical: "5" }] });
      const audit = new MemoryAudit();
      audit.delayMs = 250;
      const runs = await Promise.all(
        Array.from({ length: 4 }, () =>
          new StockMaintenance({ db: pool, audit: new AuditService(audit) }).checkSnapshotFreshness(
            { staleHours: 24 },
          ),
        ),
      );
      expect(audit.for(ctx.warehouseId, "stock.snapshot.stale")).toHaveLength(1);
      expect(runs.filter((r) => r.skipped).length).toBeGreaterThanOrEqual(1);
      expect(runs.reduce((sum, r) => sum + r.alerts, 0)).toBe(1);
      // o rulare ulterioară, după ce lock-ul s-a eliberat, vede starea și nu repetă
      await new StockMaintenance({
        db: pool,
        audit: new AuditService(audit),
      }).checkSnapshotFreshness({ staleHours: 24 });
      expect(audit.for(ctx.warehouseId, "stock.snapshot.stale")).toHaveLength(1);
    });
  });

  it("4 instanțe șterg deodată 40 de cereri vechi: total exact 40, fără erori", async () => {
    await withCommitted(async (ctx) => {
      const created = await addStockProduct(pool, ctx, { variants: [{ physical: "0" }] });
      const variantId = created.variants[0]!.id;
      await pool.backInStockAlert.createMany({
        data: Array.from({ length: 40 }, (_, i) => ({
          variantId,
          email: `v${i}@exemplu.test`,
          createdAt: days(new Date(), -200),
        })),
      });
      const runs = await Promise.all(
        Array.from({ length: 4 }, () =>
          new StockMaintenance({
            db: pool,
            audit: new AuditService(new MemoryAudit()),
            batchSize: 6,
          }).purgeBackInStockAlerts({ retentionDays: 90 }),
        ),
      );
      expect(runs.reduce((sum, r) => sum + r.unsent, 0)).toBe(40);
      expect(await pool.backInStockAlert.count({ where: { variantId } })).toBe(0);
    });
  });

  it("un rând blocat de altă instanță se sare, nu se așteaptă: restul se șterg imediat, iar rândul blocat se șterge la rularea următoare", async () => {
    await withCommitted(async (ctx) => {
      const created = await addStockProduct(pool, ctx, { variants: [{ physical: "0" }] });
      const variantId = created.variants[0]!.id;
      await pool.backInStockAlert.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          variantId,
          email: `b${i}@exemplu.test`,
          createdAt: days(new Date(), -200 - i),
        })),
      });
      const oldest = await pool.backInStockAlert.findFirstOrThrow({
        where: { variantId },
        orderBy: { createdAt: "asc" },
      });
      // altă instanță ține blocat cel mai vechi rând (de ex. un expeditor care îl procesează chiar acum)
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signalLocked: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const holder = pool.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM back_in_stock_alert WHERE id = ${oldest.id} FOR UPDATE`;
          signalLocked();
          await hold;
        },
        { timeout: 30_000 },
      );
      try {
        await locked;
        const maintenance = new StockMaintenance({
          db: pool,
          audit: new AuditService(new MemoryAudit()),
          batchSize: 2,
        });
        const outcome = await Promise.race([
          maintenance.purgeBackInStockAlerts({ retentionDays: 90 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("curățarea AȘTEAPTĂ rândul blocat")), 4_000),
          ),
        ]);
        expect(outcome.unsent).toBe(4);
        expect(await pool.backInStockAlert.count({ where: { variantId } })).toBe(1);
      } finally {
        release();
        await holder;
      }
      expect(
        (
          await new StockMaintenance({
            db: pool,
            audit: new AuditService(new MemoryAudit()),
          }).purgeBackInStockAlerts({ retentionDays: 90 })
        ).unsent,
      ).toBe(1);
      expect(await pool.backInStockAlert.count({ where: { variantId } })).toBe(0);
    });
  });
});
