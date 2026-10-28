import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, type Quantity } from "@ecom/shared";
import {
  buildReport,
  type FabricatedRow,
} from "../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { runBaseSeed } from "../seed/base-seed";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import {
  STOCK_IMPORT_LIST_LIMIT,
  StockReportImportService,
  type ApplyInput,
  type StockImportSettingsPort,
  type StockSnapshotApplier,
} from "./stock-report-import";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 12c: serviciul importului «stoc la zi» pe baza reală, în tranzacție anulată. Fișiere FABRICATE (rânduri
 * inventate). Testul nu presupune seed (depozitul implicit îl creează `runBaseSeed`) și nu presupune baza goală: caută
 * variantele lui, nu numără tot catalogul. Ora curentă e fixată în 2099, ca nicio poză comisă de alte teste să nu fie mai nouă.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const NOW = new Date("2099-01-01T12:00:00Z");
const TAKEN = new Date("2099-01-01T11:00:00Z");
const hoursAfter = (base: Date, n: number): Date => new Date(base.getTime() + n * 3_600_000);
const WAREHOUSE = "Gestiune Test";

const owner: PermissionSubject = {
  userId: "user-owner",
  email: "owner@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};
const person = (...permissions: string[]): PermissionSubject => ({
  userId: "user-x",
  email: "x@test.invalid",
  roles: ["depozit"],
  permissions: new Set(["admin.access", ...permissions]),
});
const reader = person("inventory.read");
const writer = person("inventory.read", "inventory.write");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  audit: MemoryAudit;
  warehouses: string[];
  written: string[][];
  service: StockReportImportService;
  product: (spec?: ProductSpec) => Promise<{ id: string; sku: string }>;
  file: (rows: Array<Omit<FabricatedRow, "warehouse"> & { warehouse?: string }>) => Uint8Array;
  apply: (
    bytes: Uint8Array,
    over?: Partial<ApplyInput>,
  ) => Promise<Awaited<ReturnType<StockReportImportService["apply"]>>>;
  physical: (variantId: string) => Promise<bigint | null>;
  withStock: (wrap: (inner: StockSnapshotApplier) => StockSnapshotApplier) => void;
}

async function withImport<T>(
  fn: (h: Harness) => Promise<T>,
  options: { warehouses?: string[]; now?: Date } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const audit = new MemoryAudit();
    const warehouses = [...(options.warehouses ?? [WAREHOUSE])];
    const written: string[][] = [];
    const settings: StockImportSettingsPort = {
      read: async () => ({
        warehouses: [...warehouses],
        timeZone: "Europe/Bucharest",
        safetyWindowMinutes: 30,
      }),
      writeWarehouses: async (names) => {
        written.push(names);
        warehouses.splice(0, warehouses.length, ...names);
        return [...names];
      },
    };
    let wrapStock: ((inner: StockSnapshotApplier) => StockSnapshotApplier) | null = null;
    const service = new StockReportImportService({
      db: tx,
      audit: new AuditService(audit),
      settings,
      now: () => options.now ?? NOW,
      createStock: (inner, now) => {
        const real = new StockService({ db: inner, now });
        return wrapStock ? wrapStock(real) : real;
      },
    });
    const harness: Harness = {
      tx,
      ctx,
      audit,
      warehouses,
      written,
      service,
      product: async (spec) => {
        const created = await addStockProduct(tx, ctx, spec);
        return { id: created.variants[0]!.id, sku: created.variants[0]!.sku };
      },
      file: (rows) =>
        new Uint8Array(
          buildReport({
            format: "xlsx",
            dateText: "Data: 01.01.2099",
            rows: rows.map((r) => ({ warehouse: WAREHOUSE, ...r })),
          }),
        ),
      apply: async (bytes, over = {}) => {
        const preview = await service.preview(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
        });
        return service.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
          planHash: preview.planHash ?? "0".repeat(64),
          acknowledgeTimeWarnings: false,
          ...over,
        });
      },
      physical: async (variantId) => {
        const item = await tx.inventoryItem.findFirst({
          where: { variantId, warehouseId: ctx.warehouseId },
          select: { physical: true },
        });
        return item ? item.physical : null;
      },
      withStock: (wrap) => {
        wrapStock = wrap;
      },
    };
    return fn(harness);
  });
}

describe("previzualizare", () => {
  it("nu modifică nimic: nici stoc, nici poze, nici mișcări, nici audit", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "2" }] });
      const before = await h.tx.stockSnapshot.count();
      const moves = await h.tx.stockMovement.count();
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: a.sku, unit: "BUC", quantity: 7 }]),
        fileName: "raport.xlsx",
        takenAt: TAKEN,
      });
      expect(preview.status).toBe("ready");
      expect(preview.lines.items.map((l) => [l.sku, l.quantity, l.current, l.difference])).toEqual([
        [a.sku, "7", "2", "+5"],
      ]);
      expect(await h.physical(a.id)).toBe(q("2"));
      expect(await h.tx.stockSnapshot.count()).toBe(before);
      expect(await h.tx.stockMovement.count()).toBe(moves);
      expect(h.audit.rows).toHaveLength(0);
    });
  });

  it("listează gestiunile din fișier și o marchează pe cea aleasă; fără gestiune aleasă nu aplică", async () => {
    await withImport(
      async (h) => {
        const a = await h.product();
        const bytes = h.file([
          { code: a.sku, unit: "BUC", quantity: 1 },
          { code: a.sku, unit: "BUC", quantity: 9, warehouse: "Alta Gestiune" },
        ]);
        const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
        expect(preview.status).toBe("warehouse");
        expect(preview.warehouseProblem?.kind).toBe("none_chosen");
        expect(preview.canApply).toBe(false);
        expect(preview.planHash).toBeNull();
        expect(preview.warehousesInFile.map((w) => [w.name, w.rows, w.chosen])).toEqual([
          [WAREHOUSE, 1, false],
          ["Alta Gestiune", 1, false],
        ]);
        expect(
          await codeOf(
            h.service.apply(owner, {
              bytes,
              fileName: null,
              takenAt: TAKEN,
              planHash: "0".repeat(64),
              acknowledgeTimeWarnings: false,
            }),
          ),
        ).toBe("STOCK_IMPORT_WAREHOUSE_REQUIRED");
      },
      { warehouses: [] },
    );
  });

  it("gestiunea aleasă care nu apare în fișier: problemă explicită, cu lista celor găsite", async () => {
    await withImport(
      async (h) => {
        const a = await h.product();
        const preview = await h.service.preview(owner, {
          bytes: h.file([{ code: a.sku, unit: "BUC", quantity: 1 }]),
          fileName: null,
          takenAt: TAKEN,
        });
        expect(preview.warehouseProblem?.kind).toBe("not_found");
        expect(preview.warehouseProblem?.message).toContain(WAREHOUSE);
        expect(preview.warehousesInFile.map((w) => w.chosen)).toEqual([false]);
      },
      { warehouses: ["Gestiune Inexistenta"] },
    );
  });

  it("ora implicită este cea curentă; data din fișier diferită de azi dă avertisment, fără să blocheze", async () => {
    await withImport(async (h) => {
      const a = await h.product();
      const bytes = new Uint8Array(
        buildReport({
          format: "xlsx",
          dateText: "Data: 15.03.2098",
          rows: [{ warehouse: WAREHOUSE, code: a.sku, unit: "BUC", quantity: 1 }],
        }),
      );
      const preview = await h.service.preview(owner, { bytes, fileName: null });
      expect(preview.takenAt).toBe(NOW.toISOString());
      expect(preview.fileDate).toBe("2098-03-15");
      expect(preview.timeWarnings.map((w) => w.kind)).toContain("file_date_not_today");
      expect(preview.canApply).toBe(true);
    });
  });
});

describe("aplicare", () => {
  it("scrie poza, stocul fizic, mișcările și auditul, fără valori din fișier în raport", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "2" }] });
      const b = await h.product({ variants: [{ physical: null }] });
      const bytes = h.file([
        { code: a.sku, unit: "BUC", quantity: 7 },
        { code: b.sku, unit: "BUC", quantity: 3 },
        { code: "NECUNOSCUT-1", unit: "BUC", quantity: 4 },
      ]);
      const result = await h.apply(bytes);
      expect(result).toMatchObject({ applied: 2, zeroed: 0 });

      expect(await h.physical(a.id)).toBe(q("7"));
      expect(await h.physical(b.id)).toBe(q("3"));
      const item = await h.tx.inventoryItem.findFirstOrThrow({
        where: { variantId: a.id, warehouseId: h.ctx.warehouseId },
      });
      expect(item.physicalAsOf?.toISOString()).toBe(TAKEN.toISOString());

      const snapshot = await h.tx.stockSnapshot.findUniqueOrThrow({
        where: { id: result.snapshotId },
      });
      expect(snapshot).toMatchObject({
        warehouseId: h.ctx.warehouseId,
        source: "import",
        fileName: "raport.xlsx",
        rowCount: 3,
        actorId: owner.userId,
        actorLabel: owner.email,
      });
      expect(snapshot.takenAt.toISOString()).toBe(TAKEN.toISOString());
      expect(snapshot.fileHash).toMatch(/^[0-9a-f]{64}$/);
      const reportText = JSON.stringify(snapshot.report);
      expect(reportText).not.toContain("NECUNOSCUT-1");
      expect(reportText).not.toContain(a.sku);
      expect(snapshot.report).toMatchObject({ version: 1, zeroedMissing: 0 });

      const moves = await h.tx.stockMovement.findMany({
        where: { snapshotId: result.snapshotId },
        orderBy: { variantId: "asc" },
      });
      expect(moves.map((m) => m.kind)).toEqual(["snapshot", "snapshot"]);
      expect(moves.map((m) => m.deltaPhysical).sort()).toEqual([q("3"), q("5")].sort());

      const audit = h.audit.for(result.snapshotId, "stock.import.apply");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: owner.userId,
        entity: "stock_snapshot",
        after: expect.objectContaining({ applied: 2, zeroedMissing: 0 }),
      });
    });
  });

  it("a doua rulare cu același fișier: «neschimbate», fără mișcări noi, dar cu poză nouă", async () => {
    await withImport(
      async (h) => {
        const a = await h.product({ variants: [{ physical: "0" }] });
        const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]);
        const first = await h.apply(bytes);
        const movesAfterFirst = await h.tx.stockMovement.count({ where: { variantId: a.id } });

        const later = hoursAfter(TAKEN, 1);
        const preview = await h.service.preview(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: later,
        });
        expect(preview.counters).toMatchObject({ changed: 0, unchanged: 1 });
        const second = await h.service.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: later,
          planHash: preview.planHash as string,
          acknowledgeTimeWarnings: false,
        });
        expect(second.snapshotId).not.toBe(first.snapshotId);
        expect(await h.tx.stockMovement.count({ where: { variantId: a.id } })).toBe(
          movesAfterFirst,
        );
        expect(await h.physical(a.id)).toBe(q("5"));
      },
      { now: hoursAfter(NOW, 2) },
    );
  });

  it("toată-sau-deloc: o eroare la a treia variantă anulează poza și primele două", async () => {
    await withImport(async (h) => {
      const items = [
        await h.product({ variants: [{ physical: "1" }] }),
        await h.product({ variants: [{ physical: "1" }] }),
        await h.product({ variants: [{ physical: "1" }] }),
      ];
      const bytes = h.file(items.map((i) => ({ code: i.sku, unit: "BUC", quantity: 9 })));
      let calls = 0;
      h.withStock((real) => ({
        applySnapshot: async (input) => {
          calls += 1;
          if (calls === 3) throw new Error("cădere simulată la a treia variantă");
          return real.applySnapshot(input);
        },
      }));
      const snapshots = await h.tx.stockSnapshot.count();
      const moves = await h.tx.stockMovement.count();
      await expect(h.apply(bytes)).rejects.toThrow("cădere simulată");
      expect(calls).toBe(3);
      expect(await h.tx.stockSnapshot.count()).toBe(snapshots);
      expect(await h.tx.stockMovement.count()).toBe(moves);
      for (const item of items) expect(await h.physical(item.id)).toBe(q("1"));
      expect(h.audit.rows).toHaveLength(0);
    });
  });

  it("o variantă cu o sincronizare mai nouă decât ora raportului anulează tot", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "1" }] });
      const b = await h.product({ variants: [{ physical: "1" }] });
      await h.tx.inventoryItem.updateMany({
        where: { variantId: b.id, warehouseId: h.ctx.warehouseId },
        data: { physicalAsOf: hoursAfter(TAKEN, 5) },
      });
      const bytes = h.file([
        { code: a.sku, unit: "BUC", quantity: 9 },
        { code: b.sku, unit: "BUC", quantity: 9 },
      ]);
      expect(await codeOf(h.apply(bytes))).toBe("STOCK_IMPORT_NOT_NEWER");
      expect(await h.physical(a.id)).toBe(q("1"));
      expect(await h.physical(b.id)).toBe(q("1"));
    });
  });

  it("o poză mai veche decât ultima aplicată în depozit nu se aplică", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      await h.apply(h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]));
      const older = new Date(TAKEN.getTime() - 3_600_000);
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 8 }]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: older });
      expect(preview.canApply).toBe(false);
      expect(preview.blockers).toHaveLength(1);
      expect(preview.status).toBe("blocked");
      expect(
        await codeOf(
          h.service.apply(owner, {
            bytes,
            fileName: null,
            takenAt: older,
            planHash: preview.planHash as string,
            acknowledgeTimeWarnings: true,
          }),
        ),
      ).toBe("STOCK_IMPORT_NOT_NEWER");
      expect(await h.physical(a.id)).toBe(q("5"));
    });
  });

  it("amprenta: stocul sau fișierul schimbate după previzualizare opresc aplicarea", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "2" }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 7 }]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      const input = (over: Partial<ApplyInput> = {}): ApplyInput => ({
        bytes,
        fileName: null,
        takenAt: TAKEN,
        planHash: preview.planHash as string,
        acknowledgeTimeWarnings: false,
        ...over,
      });

      const other = h.file([{ code: a.sku, unit: "BUC", quantity: 8 }]);
      expect(await codeOf(h.service.apply(owner, input({ bytes: other })))).toBe(
        "STOCK_IMPORT_PLAN_CHANGED",
      );
      await h.tx.inventoryItem.updateMany({
        where: { variantId: a.id, warehouseId: h.ctx.warehouseId },
        data: { physical: q("4") },
      });
      expect(await codeOf(h.service.apply(owner, input()))).toBe("STOCK_IMPORT_PLAN_CHANGED");
      expect(await h.physical(a.id)).toBe(q("4"));
      expect(await codeOf(h.service.apply(owner, input({ planHash: "f".repeat(64) })))).toBe(
        "STOCK_IMPORT_PLAN_CHANGED",
      );
    });
  });

  it("fișier cu erori de rând: nimic nu se aplică", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "2" }] });
      const b = await h.product({ variants: [{ physical: "2" }] });
      const bytes = h.file([
        { code: a.sku, unit: "BUC", quantity: 7 },
        { code: b.sku, unit: "KG", quantity: 1 },
      ]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.status).toBe("blocked");
      expect(preview.errors.items.map((e) => e.kind)).toEqual(["unit_mismatch"]);
      expect(await codeOf(h.apply(bytes))).toBe("STOCK_IMPORT_PLAN_HAS_ERRORS");
      expect(await h.physical(a.id)).toBe(q("2"));
    });
  });

  it("ora cu avertismente cere bifa «am verificat»; o dată invalidă se refuză", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]);
      const future = hoursAfter(NOW, 3);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: future });
      expect(preview.timeWarnings.map((w) => w.kind)).toContain("taken_at_in_future");
      const input = (acknowledge: boolean): ApplyInput => ({
        bytes,
        fileName: null,
        takenAt: future,
        planHash: preview.planHash as string,
        acknowledgeTimeWarnings: acknowledge,
      });
      expect(await codeOf(h.service.apply(owner, input(false)))).toBe(
        "STOCK_IMPORT_TIME_NOT_ACKNOWLEDGED",
      );
      expect(await h.physical(a.id)).toBe(q("0"));
      await h.service.apply(owner, input(true));
      expect(await h.physical(a.id)).toBe(q("5"));

      const invalid = await h.service.preview(owner, {
        bytes,
        fileName: null,
        takenAt: new Date("nu-e-data"),
      });
      expect(invalid.timeValid).toBe(false);
      expect(invalid.canApply).toBe(false);
      expect(
        await codeOf(h.service.apply(owner, { ...input(true), takenAt: new Date("nu-e-data") })),
      ).toBe("STOCK_IMPORT_TIME_INVALID");
    });
  });

  it("variantele lipsă din fișier rămân neatinse fără confirmare", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "1" }] });
      const missing = await h.product({ variants: [{ physical: "6" }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 2 }]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.missing.items.map((m) => [m.sku, m.currentPhysical])).toContainEqual([
        missing.sku,
        "6",
      ]);
      await h.apply(bytes);
      expect(await h.physical(missing.id)).toBe(q("6"));
    });
  });

  it("«lipsă → 0» doar cu bifa și cu numărul exact; altfel nu se atinge nimic", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "1" }] });
      const missing = await h.product({ variants: [{ physical: "6" }] });
      const neverStocked = await h.product({ variants: [{ physical: null }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 2 }]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      const count = preview.missing.total;
      expect(count).toBeGreaterThanOrEqual(2);

      expect(
        await codeOf(h.apply(bytes, { zeroMissing: { confirm: true, expectedCount: count + 1 } })),
      ).toBe("STOCK_IMPORT_ZERO_COUNT_MISMATCH");
      expect(await h.physical(missing.id)).toBe(q("6"));
      expect(await h.physical(a.id)).toBe(q("1"));

      const result = await h.apply(bytes, { zeroMissing: { confirm: true, expectedCount: count } });
      expect(result.zeroed).toBe(count);
      expect(await h.physical(a.id)).toBe(q("2"));
      expect(await h.physical(missing.id)).toBe(0n);
      expect(await h.physical(neverStocked.id)).toBe(0n);
      const move = await h.tx.stockMovement.findFirstOrThrow({
        where: { variantId: missing.id, snapshotId: result.snapshotId },
      });
      expect(move.deltaPhysical).toBe(-q("6"));
      const snapshot = await h.tx.stockSnapshot.findUniqueOrThrow({
        where: { id: result.snapshotId },
      });
      expect(snapshot.report).toMatchObject({ zeroedMissing: count });
    });
  });

  it("variantele negestionate nu se aplică și nu li se pornește gestionarea", async () => {
    await withImport(async (h) => {
      const off = await h.product({ manageStock: false, variants: [{ physical: null }] });
      const on = await h.product({ variants: [{ physical: "0" }] });
      const bytes = h.file([
        { code: off.sku, unit: "BUC", quantity: 5 },
        { code: on.sku, unit: "BUC", quantity: 1 },
      ]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.unmanaged.items.map((u) => u.sku)).toEqual([off.sku]);
      await h.apply(bytes);
      expect(await h.physical(off.id)).toBeNull();
      const product = await h.tx.product.findFirstOrThrow({
        where: { variants: { some: { id: off.id } } },
      });
      expect(product.manageStock).toBe(false);
      expect(await h.physical(on.id)).toBe(q("1"));
    });
  });

  it("un produs digital apare ca negestionat, chiar dacă bifa produsului e pornită", async () => {
    await withImport(async (h) => {
      const digital = await h.product({
        type: "digital",
        manageStock: true,
        variants: [{ physical: null }],
      });
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: digital.sku, unit: "BUC", quantity: 5 }]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.unmanaged.items.map((u) => u.sku)).toEqual([digital.sku]);
      expect(preview.lines.items).toHaveLength(0);
    });
  });
});

describe("drepturi", () => {
  it("previzualizarea și aplicarea cer inventory.write; istoricul cere inventory.read", async () => {
    await withImport(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 1 }]);
      const apply: ApplyInput = {
        bytes,
        fileName: null,
        takenAt: TAKEN,
        planHash: "0".repeat(64),
        acknowledgeTimeWarnings: false,
      };
      expect(await codeOf(h.service.preview(reader, { bytes, fileName: null }))).toBe(
        "AUTH_FORBIDDEN",
      );
      expect(await codeOf(h.service.apply(reader, apply))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(h.service.preview(null, { bytes, fileName: null }))).toBe(
        "AUTH_UNAUTHENTICATED",
      );
      expect(await codeOf(h.service.apply(null, apply))).toBe("AUTH_UNAUTHENTICATED");
      expect(await codeOf(h.service.setWarehouses(reader, ["X"]))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(h.service.history(person("products.read")))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(h.service.history(null))).toBe("AUTH_UNAUTHENTICATED");
      await expect(h.service.history(reader)).resolves.toBeDefined();
      await expect(
        h.service.preview(writer, { bytes, fileName: null, takenAt: TAKEN }),
      ).resolves.toBeDefined();
    });
  });
});

describe("istoric", () => {
  it("arată pozele cele mai noi primele, cu fișierul, autorul și contoarele din raport", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]);
      const first = await h.apply(bytes);
      const history = await h.service.history(reader);
      const row = history.rows.find((r) => r.id === first.snapshotId);
      expect(row).toMatchObject({
        fileName: "raport.xlsx",
        actorLabel: owner.email,
        source: "import",
        rowCount: 1,
        changed: 1,
        unchanged: 0,
        zeroed: 0,
      });
      expect(row?.fileHash).toHaveLength(12);
      expect(history.rows[0]?.id).toBe(first.snapshotId);
      expect(history.total).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("gestiunile alese", () => {
  it("se scriu fără dubluri, cu audit înainte/după; aceeași valoare nu mai scrie audit", async () => {
    await withImport(async (h) => {
      const saved = await h.service.setWarehouses(writer, ["  Gestiune A ", "gestiune a", "B"]);
      expect(saved).toEqual(["Gestiune A", "B"]);
      const rows = h.audit.rows.filter((r) => r.action === "stock.import.warehouses.update");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: "setting",
        entityId: "inventory.smartbillWarehouses",
        before: { warehouses: [WAREHOUSE] },
        after: { warehouses: ["Gestiune A", "B"] },
      });
      await h.service.setWarehouses(writer, ["Gestiune A", "B"]);
      expect(
        h.audit.rows.filter((r) => r.action === "stock.import.warehouses.update"),
      ).toHaveLength(1);
    });
  });

  it("refuză nume goale, prea lungi sau mai mult de 20", async () => {
    await withImport(async (h) => {
      expect(await codeOf(h.service.setWarehouses(writer, [" "]))).toBe(
        "STOCK_IMPORT_WAREHOUSES_INVALID",
      );
      expect(await codeOf(h.service.setWarehouses(writer, ["x".repeat(101)]))).toBe(
        "STOCK_IMPORT_WAREHOUSES_INVALID",
      );
      expect(
        await codeOf(
          h.service.setWarehouses(
            writer,
            Array.from({ length: 21 }, (_, i) => `G${i}`),
          ),
        ),
      ).toBe("STOCK_IMPORT_WAREHOUSES_INVALID");
      expect(await codeOf(h.service.setWarehouses(writer, "nu-e-lista"))).toBe(
        "STOCK_IMPORT_WAREHOUSES_INVALID",
      );
      expect(h.written).toHaveLength(0);
    });
  });
});

describe("catalogul în plan", () => {
  it("unitatea SmartBill vine din variantă sau din unitate; conversiile «pași» și «raport» se aplică exact", async () => {
    await withImport(async (h) => {
      await h.tx.measureUnit.update({
        where: { id: h.ctx.unitId },
        data: { smartbillName: "MP" },
      });
      const same = await h.product({ step: "0,5", variants: [{ physical: "0" }] });
      const steps = await h.product({ step: "0,3", variants: [{ physical: "0" }] });
      const ratio = await h.product({ step: "1", variants: [{ physical: "0" }] });
      await h.tx.productVariant.update({
        where: { id: steps.id },
        data: { smartbillMode: "steps", smartbillUnitName: "ROLA" },
      });
      await h.tx.productVariant.update({
        where: { id: ratio.id },
        data: { smartbillMode: "ratio", smartbillRatio: 25_000, smartbillUnitName: "SAC" },
      });
      const bytes = h.file([
        { code: same.sku, unit: "MP", quantity: 2.5 },
        { code: steps.sku, unit: "ROLA", quantity: 5 },
        { code: ratio.sku, unit: "SAC", quantity: 4 },
      ]);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.errors.items).toEqual([]);
      await h.apply(bytes);
      expect(await h.physical(same.id)).toBe(q("2.5"));
      // 5 bucăți SmartBill × pasul 0,3 = 1,5
      expect(await h.physical(steps.id)).toBe(q("1.5"));
      // 4 saci × 2,5 = 10
      expect(await h.physical(ratio.id)).toBe(q("10"));
    });
  });

  it("pasul propriu al variantei bate pe cel al produsului la conversia «pași»", async () => {
    await withImport(async (h) => {
      await h.tx.measureUnit.update({ where: { id: h.ctx.unitId }, data: { smartbillName: "MP" } });
      const a = await h.product({ step: "1", variants: [{ physical: "0" }] });
      await h.tx.productVariant.update({
        where: { id: a.id },
        data: { smartbillMode: "steps", smartbillUnitName: "ROLA", saleStep: 3000 },
      });
      await h.apply(h.file([{ code: a.sku, unit: "ROLA", quantity: 5 }]));
      // 5 bucăți × pasul variantei (0,3), nu × pasul produsului (1)
      expect(await h.physical(a.id)).toBe(q("1.5"));
    });
  });

  it("stocul curent din plan e cel al depozitului vizat, nu al altuia", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: null }] });
      const other = await h.tx.warehouse.create({
        data: { code: `alt_${h.ctx.tag}`, name: `Alt depozit ${h.ctx.tag}` },
      });
      await h.tx.inventoryItem.create({
        data: { variantId: a.id, warehouseId: other.id, physical: q("9") },
      });
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: a.sku, unit: "BUC", quantity: 4 }]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.lines.items.map((l) => [l.sku, l.current])).toEqual([[a.sku, null]]);
    });
  });

  it("eticheta variantei din raport conține titlul produsului", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: a.sku, unit: "BUC", quantity: 1 }]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.lines.items[0]?.label).toContain("Produs stoc");
    });
  });

  it("unitatea greșită față de cea a variantei se refuză, nu se ghicește", async () => {
    await withImport(async (h) => {
      await h.tx.measureUnit.update({
        where: { id: h.ctx.unitId },
        data: { smartbillName: "MP" },
      });
      const a = await h.product({ step: "1", variants: [{ physical: "0" }] });
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: a.sku, unit: "BUC", quantity: 1 }]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.errors.items.map((e) => e.kind)).toEqual(["unit_mismatch"]);
      expect(preview.canApply).toBe(false);
    });
  });

  it("un produs din coșul de gunoi nu se potrivește: codul lui rămâne necunoscut", async () => {
    await withImport(async (h) => {
      const gone = await h.product({ variants: [{ physical: "1" }] });
      await h.tx.product.updateMany({
        where: { variants: { some: { id: gone.id } } },
        data: { deletedAt: new Date("2099-01-01T00:00:00Z") },
      });
      const preview = await h.service.preview(owner, {
        bytes: h.file([{ code: gone.sku, unit: "BUC", quantity: 5 }]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.unknownCodes.items.map((u) => u.code)).toEqual([gone.sku]);
      expect(preview.lines.total).toBe(0);
    });
  });

  it("variantă cu bifă proprie peste produs: bifa variantei hotărăște", async () => {
    await withImport(async (h) => {
      const created = await addStockProduct(h.tx, h.ctx, {
        manageStock: true,
        variants: [{ physical: "0" }, { physical: "0" }],
      });
      const [on, off] = created.variants as [
        { id: string; sku: string },
        { id: string; sku: string },
      ];
      await h.tx.productVariant.update({ where: { id: off.id }, data: { manageStock: false } });
      const preview = await h.service.preview(owner, {
        bytes: h.file([
          { code: on.sku, unit: "BUC", quantity: 1 },
          { code: off.sku, unit: "BUC", quantity: 1 },
        ]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.lines.items.map((l) => l.sku)).toEqual([on.sku]);
      expect(preview.unmanaged.items.map((u) => u.sku)).toEqual([off.sku]);
    });
  });
});

describe("D1 și listele", () => {
  it("fereastra de siguranță din setări: factura din fereastră rămâne angajată după poză", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "10" }] });
      const stock = new StockService({ db: h.tx, now: () => NOW });
      const ref = { refType: "order", refId: `${h.ctx.tag}-fereastra` };
      await stock.commitDirect(ref, [
        { variantId: a.id, warehouseId: h.ctx.warehouseId, quantity: q("3") },
      ]);
      // factura cu 10 minute înaintea pozei, în fereastra de 30 de minute: poza nu o conține încă
      await stock.markInvoiced(ref, new Date(TAKEN.getTime() - 10 * 60_000));
      await h.apply(h.file([{ code: a.sku, unit: "BUC", quantity: 20 }]));
      const item = await h.tx.inventoryItem.findFirstOrThrow({
        where: { variantId: a.id, warehouseId: h.ctx.warehouseId },
      });
      expect(item.physical).toBe(q("20"));
      expect(item.committed).toBe(q("3"));
    });
  });

  it("factura de dinaintea ferestrei e deja în poză: angajarea se oglindește", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "10" }] });
      const stock = new StockService({ db: h.tx, now: () => NOW });
      const ref = { refType: "order", refId: `${h.ctx.tag}-veche` };
      await stock.commitDirect(ref, [
        { variantId: a.id, warehouseId: h.ctx.warehouseId, quantity: q("3") },
      ]);
      await stock.markInvoiced(ref, new Date(TAKEN.getTime() - 3 * 3_600_000));
      const result = await h.apply(h.file([{ code: a.sku, unit: "BUC", quantity: 20 }]));
      expect(result.mirrored).toBe(1);
      const item = await h.tx.inventoryItem.findFirstOrThrow({
        where: { variantId: a.id, warehouseId: h.ctx.warehouseId },
      });
      expect(item.committed).toBe(0n);
    });
  });

  it("listele din răspuns au plafon, iar totalul și aplicarea rămân întregi", async () => {
    await withImport(async (h) => {
      const count = STOCK_IMPORT_LIST_LIMIT + 5;
      const created = await addStockProduct(h.tx, h.ctx, {
        variants: Array.from({ length: count }, () => ({ physical: "0" })),
      });
      const bytes = h.file(
        created.variants.map((v) => ({ code: v.sku, unit: "BUC", quantity: 1 })),
      );
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.lines.total).toBe(count);
      expect(preview.lines.items).toHaveLength(STOCK_IMPORT_LIST_LIMIT);
      const result = await h.apply(bytes);
      expect(result.applied).toBe(count);
      expect(await h.physical(created.variants[count - 1]!.id)).toBe(q("1"));
    });
  });

  it("istoricul: cea mai nouă poză prima", async () => {
    await withImport(
      async (h) => {
        const a = await h.product({ variants: [{ physical: "0" }] });
        const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]);
        const first = await h.apply(bytes);
        const later = hoursAfter(TAKEN, 2);
        const preview = await h.service.preview(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: later,
        });
        const second = await h.service.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: later,
          planHash: preview.planHash as string,
          acknowledgeTimeWarnings: true,
        });
        const history = await h.service.history(reader);
        const order = history.rows.map((r) => r.id);
        expect(order.indexOf(second.snapshotId)).toBeLessThan(order.indexOf(first.snapshotId));
        expect(order[0]).toBe(second.snapshotId);
        const pageTwo = await h.service.history(reader, { page: 2 });
        expect(pageTwo.rows.map((r) => r.id)).not.toContain(second.snapshotId);
      },
      { now: hoursAfter(NOW, 3) },
    );
  });
});

describe("cazuri de margine ale aplicării", () => {
  it("aceeași oră ca a ultimei poze aplicate nu e mai nouă: se refuză", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      const bytes = h.file([{ code: a.sku, unit: "BUC", quantity: 5 }]);
      await h.apply(bytes);
      const preview = await h.service.preview(owner, { bytes, fileName: null, takenAt: TAKEN });
      expect(preview.blockers).toHaveLength(1);
      expect(preview.canApply).toBe(false);
    });
  });

  it("previzualizarea arată întâi variantele care se schimbă, apoi pe cele neschimbate", async () => {
    await withImport(async (h) => {
      const same = await h.product({ variants: [{ physical: "5" }] });
      const changes = await h.product({ variants: [{ physical: "1" }] });
      const preview = await h.service.preview(owner, {
        // rândul neschimbat vine primul în fișier
        bytes: h.file([
          { code: same.sku, unit: "BUC", quantity: 5 },
          { code: changes.sku, unit: "BUC", quantity: 9 },
        ]),
        fileName: null,
        takenAt: TAKEN,
      });
      expect(preview.lines.items.map((l) => [l.sku, l.changed])).toEqual([
        [changes.sku, true],
        [same.sku, false],
      ]);
    });
  });

  it("amprenta ține seama de fișier chiar dacă liniile sunt aceleași", async () => {
    await withImport(async (h) => {
      const a = await h.product({ variants: [{ physical: "0" }] });
      const line = { code: a.sku, unit: "BUC", quantity: 5 };
      const first = h.file([line]);
      // același plan (rândul din altă gestiune se ignoră), alt fișier
      const second = h.file([line, { ...line, warehouse: "Alta Gestiune" }]);
      const one = await h.service.preview(owner, { bytes: first, fileName: null, takenAt: TAKEN });
      const two = await h.service.preview(owner, { bytes: second, fileName: null, takenAt: TAKEN });
      expect(one.fileHash).not.toBe(two.fileHash);
      expect(one.planHash).not.toBe(two.planHash);
      expect(await codeOf(h.apply(second, { planHash: one.planHash as string }))).toBe(
        "STOCK_IMPORT_PLAN_CHANGED",
      );
    });
  });

  it("variantele se aplică în ordinea fixă de blocare (după identificator)", async () => {
    await withImport(async (h) => {
      const items = [];
      for (let i = 0; i < 6; i += 1) items.push(await h.product({ variants: [{ physical: "0" }] }));
      const order: string[] = [];
      h.withStock((real) => ({
        applySnapshot: async (input) => {
          order.push(input.variantId);
          return real.applySnapshot(input);
        },
      }));
      // fișierul le dă în ordine inversă
      await h.apply(
        h.file([...items].reverse().map((i) => ({ code: i.sku, unit: "BUC", quantity: 1 }))),
      );
      expect(order).toHaveLength(6);
      expect(order).toEqual([...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  });
});
