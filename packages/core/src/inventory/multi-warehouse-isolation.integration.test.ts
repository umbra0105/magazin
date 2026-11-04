import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, parseSignedDelta } from "@ecom/shared";
import { buildReport } from "../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { runBaseSeed } from "../seed/base-seed";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { addStockProduct, createStockContext } from "../test-utils/stock-fixtures";
import { StockMaintenance } from "./stock-maintenance";
import { StockReportImportService, type StockImportSettingsPort } from "./stock-report-import";
import { StockOverviewService, type StockOverviewServiceSettings } from "./stock-overview-service";
import { createPrismaStockOverviewStore } from "./stock-overview-store";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 13, garanția principală: cât timp nu se cere explicit un depozit, un al doilea depozit (activ sau
 * dezactivat, cu stoc, poze și mișcări proprii) NU schimbă nimic din ce fac rezervările, angajările, ajustările,
 * importul «stoc la zi», disponibilitatea și ecranul Stoc. Aceeași poveste rulează pe o bază cu un singur depozit și pe una cu
 * încă două (rânduri de stoc DIFERITE, poze mai noi), iar rezultatele trebuie să fie identice. Nu depinde de steag: aceste
 * căi nu citesc steagul `multiWarehouse` și nu știu de alte depozite decât dacă li se dă `warehouseId`.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const HOUR = 3_600_000;
/** Mult în viitor față de orice poză comisă de alte teste, calculat din ceasul real */
const NOW = new Date(Date.now() + 36_500 * 24 * HOUR);
const TAKEN = new Date(NOW.getTime() - HOUR);
const EXPIRES = new Date(NOW.getTime() + 15 * 60_000);
const WAREHOUSE_NAME = "Gestiune Test";
const settings: StockOverviewServiceSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  snapshotStaleHours: 24,
  timeZone: "Europe/Bucharest",
};
const owner: PermissionSubject = {
  userId: "user-owner",
  email: "owner@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};
const q = (text: string) => parseQuantity(text);

/** Scoate din urmă tot ce diferă între două rulări chiar dacă nimic nu s-a schimbat: id-uri, ore de scriere, amprente */
const VOLATILE = new Set([
  "id",
  "planHash",
  "fileHash",
  "snapshotId",
  "movementId",
  "mirroredIds",
  "stillCommittedIds",
  "createdAt",
  "updatedAt",
]);

function scrub(value: unknown, labels: ReadonlyMap<string, string>, tag: string): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    let text = value.replaceAll(tag, "TAG").replaceAll(tag.toUpperCase(), "TAG");
    for (const [id, label] of labels) text = text.replaceAll(id, label);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, labels, tag));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, item]) => [key, scrub(item, labels, tag)]),
    );
  }
  return value;
}

/** Aceeași poveste, o dată; `extraWarehouses` adaugă depozite străine cu stoc și poze proprii */
async function story(extraWarehouses: boolean): Promise<unknown> {
  return inRolledBackTransaction(db, async (tx: TestTx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const a = await addStockProduct(tx, ctx, { variants: [{ physical: null }] });
    const b = await addStockProduct(tx, ctx, { variants: [{ physical: null }] });
    const c = await addStockProduct(tx, ctx, {
      manageStock: false,
      variants: [{ physical: null }],
    });
    const [va, vb, vc] = [a.variants[0]!, b.variants[0]!, c.variants[0]!];

    if (extraWarehouses) {
      for (const [index, active] of [true, false].entries()) {
        const other = await tx.warehouse.create({
          data: {
            code: `x${index}_${ctx.tag}`,
            name: `Străin ${index} ${ctx.tag}`,
            isActive: active,
          },
        });
        // cantități MULT diferite, angajat și rezervat nenule, o poză mai nouă decât oricare din poveste
        for (const variant of [va, vb]) {
          await tx.inventoryItem.create({
            data: {
              variantId: variant.id,
              warehouseId: other.id,
              physical: q("700"),
              committed: q("5"),
              reserved: q("3"),
              physicalAsOf: new Date(NOW.getTime() + 24 * HOUR),
            },
          });
        }
        await tx.stockSnapshot.create({
          data: {
            warehouseId: other.id,
            takenAt: new Date(NOW.getTime() + 24 * HOUR),
            source: "import",
          },
        });
      }
    }

    // rândurile depozitului implicit se creează ULTIMELE, ca să nu fie primele în ordinea fizică a tabelei: o citire care
    // nu filtrează după depozit ar lua atunci rândul unui depozit străin
    for (const [variant, physical] of [
      [va, "10"],
      [vb, "8"],
    ] as const) {
      await tx.inventoryItem.create({
        data: { variantId: variant.id, warehouseId: ctx.warehouseId, physical: q(physical) },
      });
    }

    const stock = new StockService({ db: tx, now: () => NOW });
    const maintenance = new StockMaintenance({
      db: tx,
      audit: new AuditService(new MemoryAudit()),
      now: () => NOW,
    });
    const overview = new StockOverviewService({
      store: createPrismaStockOverviewStore(tx),
      maintenance,
      readSettings: async () => settings,
    });
    const importer = new StockReportImportService({
      db: tx,
      audit: new AuditService(new MemoryAudit()),
      settings: {
        read: async () => ({
          warehouses: [WAREHOUSE_NAME],
          timeZone: "Europe/Bucharest",
          safetyWindowMinutes: 30,
        }),
        writeWarehouses: async (names) => [...names],
      } satisfies StockImportSettingsPort,
      now: () => NOW,
      createStock: (inner, now) => new StockService({ db: inner, now }),
    });

    const trace: Record<string, unknown> = {};
    const refA = { refType: "order", refId: `iso-a-${ctx.tag}` };
    const refB = { refType: "order", refId: `iso-b-${ctx.tag}` };
    const read = async (variantId: string) => stock.readInventory(variantId);

    trace["reserve"] = await stock.reserve(refA, [{ variantId: va.id, quantity: q("3") }], EXPIRES);
    trace["afterReserve"] = [await read(va.id), await read(vb.id)];
    trace["reserveTooMuch"] = await stock
      .reserve(
        { refType: "order", refId: `iso-big-${ctx.tag}` },
        [{ variantId: va.id, quantity: q("999") }],
        EXPIRES,
      )
      .then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    trace["confirm"] = await stock.confirmReservation(refA);
    trace["commit"] = await stock.commitDirect(refB, [
      { variantId: vb.id, quantity: q("1") },
      { variantId: vc.id, quantity: q("2") },
    ]);
    trace["adjust"] = await stock.adjustPhysical({
      variantId: va.id,
      delta: parseSignedDelta("+4"),
      reason: "receipt",
      note: "intrare de probă",
      effectiveAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    trace["adjustBelowZero"] = await stock
      .adjustPhysical({
        variantId: vb.id,
        delta: parseSignedDelta("-999"),
        reason: "damaged",
        note: "prea mult",
      })
      .then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    trace["threshold"] = await stock.setLowStockSteps({ variantId: va.id, steps: 3 });

    const bytes = new Uint8Array(
      buildReport({
        format: "xlsx",
        dateText: "Data: 01.01.2099",
        rows: [
          { warehouse: WAREHOUSE_NAME, code: va.sku, unit: "BUC", quantity: 12 },
          { warehouse: WAREHOUSE_NAME, code: vb.sku, unit: "BUC", quantity: 6 },
        ],
      }),
    );
    const preview = await importer.preview(owner, {
      bytes,
      fileName: "raport.xlsx",
      takenAt: TAKEN,
    });
    trace["importPreview"] = {
      status: preview.status,
      canApply: preview.canApply,
      lines: preview.lines.items.map((l) => [l.quantity, l.current, l.difference]),
    };
    trace["importApply"] = await importer.apply(owner, {
      bytes,
      fileName: "raport.xlsx",
      takenAt: TAKEN,
      planHash: preview.planHash ?? "0".repeat(64),
      acknowledgeTimeWarnings: true,
    });
    trace["afterImport"] = [await read(va.id), await read(vb.id)];
    trace["release"] = await stock.releaseCommitment(refB);
    trace["expire"] = await stock.expireDue({ variantIds: [va.id, vb.id] });
    trace["consistency"] = [
      await stock.checkConsistency(va.id),
      await stock.checkConsistency(vb.id),
    ];

    const page = await overview.list(owner, { search: ctx.tag });
    trace["overview"] = {
      warehouse: page.warehouse.name,
      total: page.total,
      rows: page.rows,
      lowStock: page.lowStock,
    };
    trace["alerts"] = (await overview.alerts(owner)).lowStock;
    trace["movements"] = (await overview.movements(owner, va.id, {})).rows;

    const labels = new Map<string, string>([
      [va.id, "VA"],
      [vb.id, "VB"],
      [vc.id, "VC"],
      [a.productId, "PA"],
      [b.productId, "PB"],
      [c.productId, "PC"],
      [ctx.warehouseId, "DEFAULT"],
    ]);
    return scrub(trace, labels, ctx.tag);
  });
}

describe("un depozit în plus nu schimbă nimic din ce nu îl cere explicit", () => {
  it("povestea completă (rezervare, angajare, ajustare, import, citiri) dă aceleași rezultate cu un singur depozit și cu trei", async () => {
    const alone = await story(false);
    const crowded = await story(true);
    expect(crowded).toEqual(alone);
  });

  it("povestea chiar face ceva (nu e goală): rezervă, aplică importul și arată rânduri", async () => {
    const alone = (await story(false)) as Record<string, unknown>;
    expect(alone["reserveTooMuch"]).toBe("STOCK_INSUFFICIENT");
    expect(alone["adjustBelowZero"]).toBe("STOCK_ADJUSTMENT_BELOW_ZERO");
    expect((alone["importPreview"] as { canApply: boolean }).canApply).toBe(true);
    expect((alone["overview"] as { rows: unknown[] }).rows).toHaveLength(3);
    expect((alone["movements"] as unknown[]).length).toBeGreaterThan(2);
  });
});
