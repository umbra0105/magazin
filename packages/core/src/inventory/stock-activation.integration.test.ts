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
import { STOCK_ACTIVATION_MAX_VARIANTS, type ActivationConfirm } from "./stock-activation-plan";
import {
  StockActivationService,
  type ActivationApplyInput,
  type ActivationApplyResult,
  type StockActivationPreview,
} from "./stock-activation";
import type { StockImportSettingsPort, StockSnapshotApplier } from "./stock-report-import";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 12e: pornirea în masă a gestionării stocului din fișierul SmartBill, pe baza reală, în tranzacție anulată.
 * Fișiere FABRICATE. Testele nu presupun seed și nu presupun baza goală (caută variantele lor, nu numără catalogul); ora
 * curentă e fixată în 2099, ca nicio poză comisă de alte teste să nu fie mai nouă. Scrise ÎNAINTEA serviciului.
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
const both = person("products.write", "inventory.write");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

interface Created {
  productId: string;
  variants: Array<{ id: string; sku: string }>;
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  audit: MemoryAudit;
  invalidated: string[][];
  service: StockActivationService;
  /** Produs negestionat (implicit), fără rânduri de stoc */
  product: (spec?: ProductSpec) => Promise<Created>;
  file: (rows: Array<Omit<FabricatedRow, "warehouse"> & { warehouse?: string }>) => Uint8Array;
  preview: (
    bytes: Uint8Array,
    options?: { startUnmatched?: boolean; takenAt?: Date },
  ) => Promise<StockActivationPreview>;
  /** Previzualizează, apoi aplică cu numerele din previzualizare */
  apply: (
    bytes: Uint8Array,
    over?: Partial<ActivationApplyInput> & { startUnmatched?: boolean },
  ) => Promise<ActivationApplyResult>;
  productFlag: (productId: string) => Promise<boolean>;
  variantFlag: (variantId: string) => Promise<boolean | null>;
  physical: (variantId: string) => Promise<bigint | null>;
  withStock: (wrap: (inner: StockSnapshotApplier) => StockSnapshotApplier) => void;
}

async function withActivation<T>(
  fn: (h: Harness) => Promise<T>,
  options: {
    warehouses?: string[];
    now?: Date;
    maxVariants?: number;
    db?: (tx: TestTx) => TestTx;
  } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const audit = new MemoryAudit();
    const warehouses = [...(options.warehouses ?? [WAREHOUSE])];
    const invalidated: string[][] = [];
    const settings: StockImportSettingsPort = {
      read: async () => ({
        warehouses: [...warehouses],
        timeZone: "Europe/Bucharest",
        safetyWindowMinutes: 30,
      }),
      writeWarehouses: async (names) => names,
    };
    let wrapStock: ((inner: StockSnapshotApplier) => StockSnapshotApplier) | null = null;
    const service = new StockActivationService({
      db: options.db ? options.db(tx) : tx,
      audit: new AuditService(audit),
      settings,
      now: () => options.now ?? NOW,
      invalidate: (tags) => {
        invalidated.push([...tags]);
      },
      ...(options.maxVariants !== undefined && { maxVariants: options.maxVariants }),
      createStock: (inner, now) => {
        const real = new StockService({ db: inner, now });
        return wrapStock ? wrapStock(real) : real;
      },
    });
    const confirmOf = (p: StockActivationPreview): ActivationConfirm => ({
      products: p.counters?.products ?? 0,
      variants: p.counters?.matched ?? 0,
      zero: p.counters?.zero ?? 0,
    });
    const harness: Harness = {
      tx,
      ctx,
      audit,
      invalidated,
      service,
      product: (spec) =>
        addStockProduct(tx, ctx, { manageStock: false, variants: [{ physical: null }], ...spec }),
      file: (rows) =>
        new Uint8Array(
          buildReport({
            format: "xlsx",
            dateText: "Data: 01.01.2099",
            rows: rows.map((r) => ({ warehouse: WAREHOUSE, ...r })),
          }),
        ),
      preview: (bytes, o = {}) =>
        service.preview(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: o.takenAt ?? TAKEN,
          startUnmatched: o.startUnmatched ?? false,
        }),
      apply: async (bytes, over = {}) => {
        const startUnmatched = over.startUnmatched ?? false;
        const preview = await service.preview(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
          startUnmatched,
        });
        return service.apply(owner, {
          bytes,
          fileName: "raport.xlsx",
          takenAt: TAKEN,
          planHash: preview.planHash ?? "0".repeat(64),
          acknowledgeTimeWarnings: false,
          startUnmatched,
          confirm: confirmOf(preview),
          ...over,
        });
      },
      productFlag: async (productId) =>
        (await tx.product.findUniqueOrThrow({ where: { id: productId } })).manageStock,
      variantFlag: async (variantId) =>
        (await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } })).manageStock,
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

const BUC = "BUC";

interface FlipHolder {
  run: (() => Promise<void>) | null;
}

/**
 * Clientul de test care rulează `holder.run` (o editare concurentă) chiar înaintea tranzacției pornirii, adică după verificarea
 * amprentei și înainte de scriere. Clientul de tranzacție de test are și el `$transaction` (tranzacție imbricată).
 */
function flippingDb(holder: FlipHolder): (tx: TestTx) => TestTx {
  return (tx) =>
    new Proxy(tx, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "$transaction") {
          return async (fn: unknown, config: unknown) => {
            if (holder.run) {
              const run = holder.run;
              holder.run = null;
              await run();
            }
            return (value as (...a: unknown[]) => Promise<unknown>).call(target, fn, config);
          };
        }
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
}

describe("previzualizare", () => {
  it("nu modifică nimic: nici bife, nici stoc, nici poze, nici mișcări, nici audit", async () => {
    await withActivation(async (h) => {
      const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const snapshots = await h.tx.stockSnapshot.count();
      const moves = await h.tx.stockMovement.count();
      const preview = await h.preview(
        h.file(a.variants.map((v) => ({ code: v.sku, unit: BUC, quantity: 3 }))),
      );
      expect(preview.status).toBe("ready");
      expect(preview.canApply).toBe(true);
      expect(preview.counters).toMatchObject({ products: 1, matched: 2, zero: 0 });
      expect(preview.changes.items).toEqual([
        expect.objectContaining({ scope: "product", id: a.productId, variants: 2 }),
      ]);
      expect(await h.productFlag(a.productId)).toBe(false);
      for (const v of a.variants) {
        expect(await h.variantFlag(v.id)).toBeNull();
        expect(await h.physical(v.id)).toBeNull();
      }
      expect(await h.tx.stockSnapshot.count()).toBe(snapshots);
      expect(await h.tx.stockMovement.count()).toBe(moves);
      expect(h.audit.rows).toHaveLength(0);
      expect(h.invalidated).toHaveLength(0);
    });
  });

  it("arată separat: de pornit, deja gestionate, oprite explicit, digitale, fără potrivire, necunoscute", async () => {
    await withActivation(async (h) => {
      const toEnable = await h.product();
      const managed = await h.product({ manageStock: true, variants: [{ physical: "1" }] });
      const explicitOff = await h.product({ manageStock: true });
      await h.tx.productVariant.update({
        where: { id: explicitOff.variants[0]!.id },
        data: { manageStock: false },
      });
      const digital = await h.product({ type: "digital" });
      const noMatch = await h.product();
      const preview = await h.preview(
        h.file([
          { code: toEnable.variants[0]!.sku, unit: BUC, quantity: 4 },
          { code: managed.variants[0]!.sku, unit: BUC, quantity: 9 },
          { code: explicitOff.variants[0]!.sku, unit: BUC, quantity: 2 },
          { code: digital.variants[0]!.sku, unit: BUC, quantity: 2 },
          { code: "NECUNOSCUT-1", unit: BUC, quantity: 1 },
        ]),
      );
      expect(preview.enabledMatched.items.map((v) => v.sku)).toEqual([toEnable.variants[0]!.sku]);
      expect(preview.counters).toMatchObject({ matched: 1, alreadyManaged: 1 });
      expect(preview.untouched.items.map((u) => [u.sku, u.reason]).sort()).toEqual(
        [
          [explicitOff.variants[0]!.sku, "explicit_off"],
          [digital.variants[0]!.sku, "digital"],
        ].sort(),
      );
      expect(preview.unmatchedEligible.items.map((v) => v.sku)).toContain(noMatch.variants[0]!.sku);
      expect(preview.unmatchedEligible.items.map((v) => v.sku)).not.toContain(
        digital.variants[0]!.sku,
      );
      expect(preview.unknownCodes.items.map((u) => u.code)).toEqual(["NECUNOSCUT-1"]);
      expect(preview.enabledZero.total).toBe(0);
    });
  });

  it("opțiunea «cu stoc 0» cuprinde exact variantele fără potrivire, cu numărul în previzualizare", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const b = await h.product();
      const without = await h.preview(
        h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]),
      );
      expect(without.startUnmatched).toBe(false);
      expect(without.enabledZero.total).toBe(0);
      const withOption = await h.preview(
        h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]),
        { startUnmatched: true },
      );
      expect(withOption.startUnmatched).toBe(true);
      expect(withOption.enabledZero.items.map((v) => v.sku)).toContain(b.variants[0]!.sku);
      expect(withOption.counters?.zero).toBe(withOption.enabledZero.total);
      expect(withOption.counters?.zero).toBeGreaterThanOrEqual(1);
      expect(withOption.planHash).not.toBe(without.planHash);
    });
  });

  it("gestiune nealeasă: fără plan, cu lista celor din fișier", async () => {
    await withActivation(
      async (h) => {
        const a = await h.product();
        const preview = await h.preview(
          h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]),
        );
        expect(preview.status).toBe("warehouse");
        expect(preview.canApply).toBe(false);
        expect(preview.planHash).toBeNull();
        expect(preview.warehousesInFile.map((w) => w.name)).toEqual([WAREHOUSE]);
      },
      { warehouses: [] },
    );
  });

  it("erori de rând (unitate greșită) blochează, fără nicio modificare", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.variants[0]!.sku, unit: "KG", quantity: 1 }]);
      const preview = await h.preview(bytes);
      expect(preview.status).toBe("blocked");
      expect(preview.errors.items.map((e) => e.kind)).toEqual(["unit_mismatch"]);
      expect(await codeOf(h.apply(bytes))).toBe("STOCK_ACTIVATION_NOT_APPLICABLE");
      expect(await h.productFlag(a.productId)).toBe(false);
    });
  });
});

describe("aplicare: nivelul și cantitățile", () => {
  it("produs acoperit întreg: se pornește produsul, cantitățile din fișier, poză, istoric, audit, cache", async () => {
    await withActivation(async (h) => {
      const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const [v1, v2] = a.variants as [{ id: string; sku: string }, { id: string; sku: string }];
      const result = await h.apply(
        h.file([
          { code: v1.sku, unit: BUC, quantity: 7 },
          { code: v2.sku, unit: BUC, quantity: 3 },
        ]),
      );
      expect(result).toMatchObject({ enabledProducts: 1, enabledVariants: 2, startedAtZero: 0 });
      expect(await h.productFlag(a.productId)).toBe(true);
      expect(await h.variantFlag(v1.id)).toBeNull();
      expect(await h.physical(v1.id)).toBe(q("7"));
      expect(await h.physical(v2.id)).toBe(q("3"));
      const item = await h.tx.inventoryItem.findFirstOrThrow({
        where: { variantId: v1.id, warehouseId: h.ctx.warehouseId },
      });
      expect(item.physicalAsOf?.toISOString()).toBe(TAKEN.toISOString());
      const snapshot = await h.tx.stockSnapshot.findUniqueOrThrow({
        where: { id: result.snapshotId },
      });
      expect(snapshot).toMatchObject({ source: "import", actorId: owner.userId, rowCount: 2 });
      expect(snapshot.report).toMatchObject({
        activation: { enabledProducts: 1, enabledVariants: 2, startedAtZero: 0 },
      });
      const moves = await h.tx.stockMovement.findMany({ where: { snapshotId: result.snapshotId } });
      expect(moves.map((m) => m.kind)).toEqual(["snapshot", "snapshot"]);
      expect(h.invalidated).toEqual([["catalog"]]);
    });
  });

  it("produs acoperit parțial: doar variantele din fișier, pe variantă; fratele rămâne negestionat", async () => {
    await withActivation(async (h) => {
      const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const [inFile, sibling] = a.variants as [
        { id: string; sku: string },
        { id: string; sku: string },
      ];
      const result = await h.apply(h.file([{ code: inFile.sku, unit: BUC, quantity: 5 }]));
      expect(result).toMatchObject({ enabledProducts: 1, enabledVariants: 1 });
      expect(await h.productFlag(a.productId)).toBe(false);
      expect(await h.variantFlag(inFile.id)).toBe(true);
      expect(await h.variantFlag(sibling.id)).toBeNull();
      expect(await h.physical(inFile.id)).toBe(q("5"));
      expect(await h.physical(sibling.id)).toBeNull();
    });
  });

  it("opțiunea «cu stoc 0»: fratele fără potrivire pornește la 0, în aceeași poză, iar produsul se pornește întreg", async () => {
    await withActivation(async (h) => {
      const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const [inFile, sibling] = a.variants as [
        { id: string; sku: string },
        { id: string; sku: string },
      ];
      const result = await h.apply(h.file([{ code: inFile.sku, unit: BUC, quantity: 5 }]), {
        startUnmatched: true,
      });
      expect(result.startedAtZero).toBeGreaterThanOrEqual(1);
      expect(await h.productFlag(a.productId)).toBe(true);
      expect(await h.physical(inFile.id)).toBe(q("5"));
      expect(await h.physical(sibling.id)).toBe(0n);
      const item = await h.tx.inventoryItem.findFirstOrThrow({
        where: { variantId: sibling.id, warehouseId: h.ctx.warehouseId },
      });
      expect(item.physicalAsOf?.toISOString()).toBe(TAKEN.toISOString());
      const snapshot = await h.tx.stockSnapshot.findUniqueOrThrow({
        where: { id: result.snapshotId },
      });
      expect(snapshot.report).toMatchObject({
        activation: { startedAtZero: result.startedAtZero },
      });
    });
  });

  it("fără bifă, variantele fără potrivire rămân negestionate și fără rând de stoc", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const lonely = await h.product();
      await h.apply(h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]));
      expect(await h.productFlag(lonely.productId)).toBe(false);
      expect(await h.physical(lonely.variants[0]!.id)).toBeNull();
    });
  });

  it("oprite explicit și digitale rămân neatinse, chiar cu opțiunea «cu stoc 0»", async () => {
    await withActivation(async (h) => {
      const off = await h.product({ manageStock: true });
      await h.tx.productVariant.update({
        where: { id: off.variants[0]!.id },
        data: { manageStock: false },
      });
      const digital = await h.product({ type: "digital" });
      const normal = await h.product();
      await h.apply(h.file([{ code: normal.variants[0]!.sku, unit: BUC, quantity: 2 }]), {
        startUnmatched: true,
      });
      expect(await h.variantFlag(off.variants[0]!.id)).toBe(false);
      expect(await h.physical(off.variants[0]!.id)).toBeNull();
      expect(await h.productFlag(digital.productId)).toBe(false);
      expect(await h.physical(digital.variants[0]!.id)).toBeNull();
    });
  });

  it("varianta deja gestionată din fișier își primește cantitatea, fără schimbare de bifă", async () => {
    await withActivation(async (h) => {
      const managed = await h.product({ manageStock: true, variants: [{ physical: "1" }] });
      const fresh = await h.product();
      await h.apply(
        h.file([
          { code: managed.variants[0]!.sku, unit: BUC, quantity: 9 },
          { code: fresh.variants[0]!.sku, unit: BUC, quantity: 4 },
        ]),
      );
      expect(await h.physical(managed.variants[0]!.id)).toBe(q("9"));
      expect(await h.productFlag(managed.productId)).toBe(true);
      expect(await h.variantFlag(managed.variants[0]!.id)).toBeNull();
    });
  });

  it("produs din coșul de gunoi: nu se pornește, codul lui e necunoscut", async () => {
    await withActivation(async (h) => {
      const gone = await h.product();
      await h.tx.product.update({
        where: { id: gone.productId },
        data: { deletedAt: new Date("2099-01-01T00:00:00Z") },
      });
      const preview = await h.preview(
        h.file([{ code: gone.variants[0]!.sku, unit: BUC, quantity: 5 }]),
        {
          startUnmatched: true,
        },
      );
      expect(preview.unknownCodes.items.map((u) => u.code)).toEqual([gone.variants[0]!.sku]);
      expect(preview.unmatchedEligible.items.map((v) => v.sku)).not.toContain(
        gone.variants[0]!.sku,
      );
    });
  });

  it("ciorna și arhivatul intră în aceeași regulă", async () => {
    await withActivation(async (h) => {
      const draft = await h.product({ status: "draft" });
      const archived = await h.product({ status: "archived" });
      const result = await h.apply(
        h.file([
          { code: draft.variants[0]!.sku, unit: BUC, quantity: 1 },
          { code: archived.variants[0]!.sku, unit: BUC, quantity: 2 },
        ]),
      );
      expect(result.enabledProducts).toBe(2);
      expect(await h.productFlag(draft.productId)).toBe(true);
      expect(await h.productFlag(archived.productId)).toBe(true);
    });
  });

  it("a doua rulare cu același fișier: nu mai e nimic de pornit", async () => {
    await withActivation(
      async (h) => {
        const a = await h.product();
        const bytes = h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]);
        await h.apply(bytes);
        const again = await h.preview(bytes, { takenAt: hoursAfter(TAKEN, 1) });
        expect(again.counters?.matched).toBe(0);
        expect(again.canApply).toBe(false);
        expect(await codeOf(h.apply(bytes, { takenAt: hoursAfter(TAKEN, 1) }))).toBe(
          "STOCK_ACTIVATION_NOTHING_TO_ENABLE",
        );
      },
      { now: hoursAfter(NOW, 2) },
    );
  });
});

describe("aplicare: toată-sau-deloc, fără fereastra «Indisponibil»", () => {
  it("o cădere la a treia variantă anulează și bifele, și poza, și stocul", async () => {
    await withActivation(async (h) => {
      const items = [await h.product(), await h.product(), await h.product()];
      const bytes = h.file(
        items.map((i) => ({ code: i.variants[0]!.sku, unit: BUC, quantity: 9 })),
      );
      let calls = 0;
      h.withStock((real) => ({
        applySnapshot: async (input) => {
          calls += 1;
          if (calls === 3) throw new Error("cădere simulată la a treia variantă");
          return real.applySnapshot(input);
        },
      }));
      const snapshots = await h.tx.stockSnapshot.count();
      await expect(h.apply(bytes)).rejects.toThrow("cădere simulată");
      expect(calls).toBe(3);
      for (const item of items) {
        expect(await h.productFlag(item.productId)).toBe(false);
        expect(await h.physical(item.variants[0]!.id)).toBeNull();
      }
      expect(await h.tx.stockSnapshot.count()).toBe(snapshots);
      expect(h.audit.rows).toHaveLength(0);
      expect(h.invalidated).toHaveLength(0);
    });
  });

  it("bifele se schimbă înaintea cantităților, în aceeași tranzacție (nicio variantă gestionată fără stoc)", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const seen: Array<{ flag: boolean; hasItem: boolean }> = [];
      h.withStock((real) => ({
        applySnapshot: async (input) => {
          const product = await h.tx.product.findUniqueOrThrow({ where: { id: a.productId } });
          const item = await h.physical(input.variantId);
          seen.push({ flag: product.manageStock, hasItem: item !== null });
          return real.applySnapshot(input);
        },
      }));
      await h.apply(h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]));
      expect(seen).toEqual([{ flag: true, hasItem: false }]);
      expect(await h.physical(a.variants[0]!.id)).toBe(q("5"));
    });
  });

  it("variantele se aplică în ordinea fixă de blocare (după identificator)", async () => {
    await withActivation(async (h) => {
      const items: Created[] = [];
      for (let i = 0; i < 6; i += 1) items.push(await h.product());
      const order: string[] = [];
      h.withStock((real) => ({
        applySnapshot: async (input) => {
          order.push(input.variantId);
          return real.applySnapshot(input);
        },
      }));
      await h.apply(
        h.file(
          [...items].reverse().map((i) => ({ code: i.variants[0]!.sku, unit: BUC, quantity: 1 })),
        ),
        { startUnmatched: true },
      );
      expect(order.length).toBeGreaterThanOrEqual(6);
      expect(order).toEqual([...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  });

  it("o variantă cu o sincronizare mai nouă decât ora raportului anulează tot, inclusiv bifele", async () => {
    await withActivation(async (h) => {
      const a = await h.product({ manageStock: true, variants: [{ physical: "1" }] });
      const b = await h.product();
      await h.tx.inventoryItem.updateMany({
        where: { variantId: a.variants[0]!.id, warehouseId: h.ctx.warehouseId },
        data: { physicalAsOf: hoursAfter(TAKEN, 5) },
      });
      const bytes = h.file([
        { code: a.variants[0]!.sku, unit: BUC, quantity: 9 },
        { code: b.variants[0]!.sku, unit: BUC, quantity: 9 },
      ]);
      expect(await codeOf(h.apply(bytes))).toBe("STOCK_IMPORT_NOT_NEWER");
      expect(await h.productFlag(b.productId)).toBe(false);
      expect(await h.physical(b.variants[0]!.id)).toBeNull();
    });
  });
});

describe("aplicare: amprenta, numerele și plafonul", () => {
  it("o bifă schimbată după previzualizare oprește aplicarea (amprenta)", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]);
      const preview = await h.preview(bytes);
      await h.tx.product.update({ where: { id: a.productId }, data: { manageStock: true } });
      expect(
        await codeOf(
          h.service.apply(owner, {
            bytes,
            fileName: null,
            takenAt: TAKEN,
            planHash: preview.planHash as string,
            acknowledgeTimeWarnings: false,
            startUnmatched: false,
            confirm: { products: 1, variants: 1, zero: 0 },
          }),
        ),
      ).toBe("STOCK_IMPORT_PLAN_CHANGED");
    });
  });

  it("o editare de bifă ivită ÎNTRE verificarea amprentei și scriere se prinde în tranzacție: se anulează tot", async () => {
    let flip: (() => Promise<void>) | null = null;
    await withActivation(
      async (h) => {
        const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
        const [first, second] = a.variants as [
          { id: string; sku: string },
          { id: string; sku: string },
        ];
        const bytes = h.file([
          { code: first.sku, unit: BUC, quantity: 5 },
          { code: second.sku, unit: BUC, quantity: 5 },
        ]);
        const preview = await h.preview(bytes);
        // editarea apare după analiză, chiar înaintea tranzacției
        flip = async () => {
          await h.tx.product.update({ where: { id: a.productId }, data: { manageStock: true } });
        };
        const code = await codeOf(
          h.service.apply(owner, {
            bytes,
            fileName: null,
            takenAt: TAKEN,
            planHash: preview.planHash as string,
            acknowledgeTimeWarnings: false,
            startUnmatched: false,
            confirm: { products: 1, variants: 2, zero: 0 },
          }),
        );
        expect(code).toBe("STOCK_IMPORT_PLAN_CHANGED");
        expect(await h.physical(first.id)).toBeNull();
        expect(
          await h.tx.stockSnapshot.count({
            where: { fileName: null, source: "import", rowCount: 2 },
          }),
        ).toBe(0);
      },
      {
        db: (tx) =>
          new Proxy(tx, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target) as unknown;
              if (prop === "$transaction") {
                // clientul de tranzacție de test are și el `$transaction` (tranzacție imbricată): editarea apare chiar înaintea ei
                return async (fn: unknown, config: unknown) => {
                  if (flip) {
                    const run = flip;
                    flip = null;
                    await run();
                  }
                  return (value as (...a: unknown[]) => Promise<unknown>).call(target, fn, config);
                };
              }
              return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(target)
                : value;
            },
          }),
      },
    );
  });

  it("o editare concurentă a variantei (oprită explicit) între verificare și scriere se prinde: se anulează tot", async () => {
    const holder: FlipHolder = { run: null };
    await withActivation(
      async (h) => {
        const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
        const first = a.variants[0] as { id: string; sku: string };
        const bytes = h.file([{ code: first.sku, unit: BUC, quantity: 5 }]);
        const preview = await h.preview(bytes);
        // doar o variantă din fișier: pornirea e pe variantă
        expect(preview.changes.items[0]?.scope).toBe("variant");
        holder.run = async () => {
          await h.tx.productVariant.update({
            where: { id: first.id },
            data: { manageStock: false },
          });
        };
        expect(
          await codeOf(
            h.service.apply(owner, {
              bytes,
              fileName: null,
              takenAt: TAKEN,
              planHash: preview.planHash as string,
              acknowledgeTimeWarnings: false,
              startUnmatched: false,
              confirm: { products: 1, variants: 1, zero: 0 },
            }),
          ),
        ).toBe("STOCK_IMPORT_PLAN_CHANGED");
        expect(await h.variantFlag(first.id)).toBe(false);
        expect(await h.physical(first.id)).toBeNull();
      },
      { db: flippingDb(holder) },
    );
  });

  it("un produs trimis în coșul de gunoi între verificare și scriere nu se pornește (pe variantă și pe produs)", async () => {
    for (const whole of [false, true]) {
      const holder: FlipHolder = { run: null };
      await withActivation(
        async (h) => {
          const a = await h.product({ variants: [{ physical: null }, { physical: null }] });
          const [first, second] = a.variants as [
            { id: string; sku: string },
            { id: string; sku: string },
          ];
          const rows = whole
            ? [
                { code: first.sku, unit: BUC, quantity: 5 },
                { code: second.sku, unit: BUC, quantity: 5 },
              ]
            : [{ code: first.sku, unit: BUC, quantity: 5 }];
          const bytes = h.file(rows);
          const preview = await h.preview(bytes);
          expect(preview.changes.items[0]?.scope).toBe(whole ? "product" : "variant");
          holder.run = async () => {
            await h.tx.product.update({
              where: { id: a.productId },
              data: { deletedAt: new Date("2099-01-01T00:00:00Z") },
            });
          };
          expect(
            await codeOf(
              h.service.apply(owner, {
                bytes,
                fileName: null,
                takenAt: TAKEN,
                planHash: preview.planHash as string,
                acknowledgeTimeWarnings: false,
                startUnmatched: false,
                confirm: { products: 1, variants: rows.length, zero: 0 },
              }),
            ),
          ).toBe("STOCK_IMPORT_PLAN_CHANGED");
          expect(await h.productFlag(a.productId)).toBe(false);
          expect(await h.physical(first.id)).toBeNull();
        },
        { db: flippingDb(holder) },
      );
    }
  });

  it("numerele confirmate trebuie să fie exact cele din previzualizare", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const b = await h.product();
      const bytes = h.file([
        { code: a.variants[0]!.sku, unit: BUC, quantity: 1 },
        { code: b.variants[0]!.sku, unit: BUC, quantity: 1 },
      ]);
      const preview = await h.preview(bytes);
      const base = {
        bytes,
        fileName: null,
        takenAt: TAKEN,
        planHash: preview.planHash as string,
        acknowledgeTimeWarnings: false,
        startUnmatched: false,
      };
      for (const bad of [
        { products: 1, variants: 2, zero: 0 },
        { products: 2, variants: 1, zero: 0 },
        { products: 2, variants: 2, zero: 1 },
      ]) {
        expect(await codeOf(h.service.apply(owner, { ...base, confirm: bad }))).toBe(
          "STOCK_ACTIVATION_COUNT_MISMATCH",
        );
      }
      expect(await h.productFlag(a.productId)).toBe(false);
    });
  });

  it("opțiunea trimisă la aplicare trebuie să fie cea previzualizată", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]);
      const preview = await h.preview(bytes);
      expect(
        await codeOf(
          h.service.apply(owner, {
            bytes,
            fileName: null,
            takenAt: TAKEN,
            planHash: preview.planHash as string,
            acknowledgeTimeWarnings: false,
            startUnmatched: true,
            confirm: { products: 1, variants: 1, zero: 0 },
          }),
        ),
      ).toBe("STOCK_IMPORT_PLAN_CHANGED");
    });
  });

  it("peste plafon: previzualizarea arată câte ar porni, iar aplicarea se refuză fără nicio modificare", async () => {
    await withActivation(
      async (h) => {
        const items = [await h.product(), await h.product(), await h.product()];
        const bytes = h.file(
          items.map((i) => ({ code: i.variants[0]!.sku, unit: BUC, quantity: 1 })),
        );
        const preview = await h.preview(bytes);
        expect(preview.counters?.matched).toBe(3);
        expect(preview.maxVariants).toBe(2);
        expect(preview.canApply).toBe(false);
        expect(preview.blockers.join(" ")).toContain("3");
        expect(preview.blockers.join(" ")).toContain("2");
        expect(await codeOf(h.apply(bytes))).toBe("STOCK_ACTIVATION_TOO_MANY");
        for (const item of items) expect(await h.productFlag(item.productId)).toBe(false);
      },
      { maxVariants: 2 },
    );
  });

  it("plafonul implicit este 5.000", () => {
    expect(STOCK_ACTIVATION_MAX_VARIANTS).toBe(5000);
  });

  it("ora cu avertismente cere bifa; o poză mai veche decât ultima aplicată se refuză", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]);
      const future = hoursAfter(NOW, 3);
      const preview = await h.preview(bytes, { takenAt: future });
      expect(preview.timeWarnings.map((w) => w.kind)).toContain("taken_at_in_future");
      const input = (ack: boolean): ActivationApplyInput => ({
        bytes,
        fileName: null,
        takenAt: future,
        planHash: preview.planHash as string,
        acknowledgeTimeWarnings: ack,
        startUnmatched: false,
        confirm: { products: 1, variants: 1, zero: 0 },
      });
      expect(await codeOf(h.service.apply(owner, input(false)))).toBe(
        "STOCK_IMPORT_TIME_NOT_ACKNOWLEDGED",
      );
      expect(await h.productFlag(a.productId)).toBe(false);
      await h.service.apply(owner, input(true));
      expect(await h.productFlag(a.productId)).toBe(true);

      const b = await h.product();
      const older = await h.preview(
        h.file([{ code: b.variants[0]!.sku, unit: BUC, quantity: 1 }]),
        {
          takenAt: TAKEN,
        },
      );
      expect(older.canApply).toBe(false);
      expect(older.blockers).toHaveLength(1);
    });
  });
});

describe("audit și drepturi", () => {
  it("un eveniment agregat și câte un rând per produs sau variantă pornită, cu înainte/după", async () => {
    await withActivation(async (h) => {
      const whole = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const partial = await h.product({ variants: [{ physical: null }, { physical: null }] });
      const result = await h.apply(
        h.file([
          { code: whole.variants[0]!.sku, unit: BUC, quantity: 1 },
          { code: whole.variants[1]!.sku, unit: BUC, quantity: 1 },
          { code: partial.variants[0]!.sku, unit: BUC, quantity: 1 },
        ]),
      );
      const aggregate = h.audit.for(result.snapshotId, "stock.activation.apply");
      expect(aggregate).toHaveLength(1);
      expect(aggregate[0]).toMatchObject({
        actorId: owner.userId,
        entity: "stock_snapshot",
        after: expect.objectContaining({
          enabledProducts: 2,
          enabledVariants: 3,
          startedAtZero: 0,
          startUnmatched: false,
        }),
      });
      const rows = h.audit.rows.filter((r) => r.action === "stock.activation.enable");
      expect(rows).toHaveLength(2);
      const productRow = rows.find((r) => r.entityId === whole.productId);
      const variantRow = rows.find((r) => r.entityId === partial.variants[0]!.id);
      expect(productRow).toMatchObject({
        entity: "product",
        before: { manageStock: false },
        after: expect.objectContaining({ manageStock: true, scope: "product", variants: 2 }),
      });
      expect(variantRow).toMatchObject({
        entity: "product_variant",
        before: { manageStock: null },
        after: expect.objectContaining({ manageStock: true, scope: "variant" }),
      });
    });
  });

  it("cu opțiunea, auditul agregat păstrează opțiunea și numărul pornit la 0", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      await h.product();
      const result = await h.apply(h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]), {
        startUnmatched: true,
      });
      const aggregate = h.audit.for(result.snapshotId, "stock.activation.apply");
      expect(aggregate[0]?.after).toMatchObject({
        startUnmatched: true,
        startedAtZero: result.startedAtZero,
      });
      expect(result.startedAtZero).toBeGreaterThanOrEqual(1);
    });
  });

  it("cere products.write ȘI inventory.write; fără sesiune, nu", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const bytes = h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 1 }]);
      const apply = (subject: PermissionSubject | null) =>
        h.service.apply(subject, {
          bytes,
          fileName: null,
          takenAt: TAKEN,
          planHash: "0".repeat(64),
          acknowledgeTimeWarnings: false,
          startUnmatched: false,
          confirm: { products: 1, variants: 1, zero: 0 },
        });
      for (const subject of [
        person("inventory.write"),
        person("products.write"),
        person("inventory.read", "products.read"),
      ]) {
        expect(await codeOf(h.service.preview(subject, { bytes, fileName: null }))).toBe(
          "AUTH_FORBIDDEN",
        );
        expect(await codeOf(apply(subject))).toBe("AUTH_FORBIDDEN");
      }
      expect(await codeOf(h.service.preview(null, { bytes, fileName: null }))).toBe(
        "AUTH_UNAUTHENTICATED",
      );
      expect(await codeOf(apply(null))).toBe("AUTH_UNAUTHENTICATED");
      await expect(
        h.service.preview(both, { bytes, fileName: null, takenAt: TAKEN }),
      ).resolves.toBeDefined();
      expect(await h.productFlag(a.productId)).toBe(false);
      expect(h.audit.rows).toHaveLength(0);
    });
  });
});

describe("istoric", () => {
  it("poza pornirii apare în istoric cu numărul de variante pornite", async () => {
    await withActivation(async (h) => {
      const a = await h.product();
      const result = await h.apply(h.file([{ code: a.variants[0]!.sku, unit: BUC, quantity: 5 }]));
      const { StockReportImportService } = await import("./stock-report-import");
      const history = await new StockReportImportService({
        db: h.tx,
        audit: new AuditService(h.audit),
        settings: {
          read: async () => ({
            warehouses: [],
            timeZone: "Europe/Bucharest",
            safetyWindowMinutes: 30,
          }),
          writeWarehouses: async (n) => n,
        },
      }).history(person("inventory.read"));
      const row = history.rows.find((r) => r.id === result.snapshotId);
      expect(row).toMatchObject({ enabled: 1, changed: 1 });
    });
  });
});
