import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { ForbiddenError, UnauthenticatedError, formatQuantity, type Quantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { runBaseSeed } from "../seed/base-seed";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockMaintenance } from "./stock-maintenance";
import { createPrismaStockOverviewStore } from "./stock-overview-store";
import { StockOverviewService, type StockOverviewServiceSettings } from "./stock-overview-service";

/**
 * Faza 5, punctul 9a: stocul unui produs (tabul Stoc din editor) și rezumatele pentru listă, pe baza reală (tranzacție
 * anulată): drepturi (`products.read` pentru stare, `inventory.read` pentru cantități), termenul de livrare cu proveniența
 * lui, valorile efective pe variantă. Nu presupune seed: depozitul implicit îl creează `runBaseSeed`.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const T0 = new Date("2026-10-22T10:00:00Z");
const settings: StockOverviewServiceSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  snapshotStaleHours: 24,
  timeZone: "Europe/Bucharest",
};

function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: StockOverviewService;
  add: (
    spec?: ProductSpec,
  ) => Promise<{ productId: string; variants: Array<{ id: string; sku: string }> }>;
}

async function withStock<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const maintenance = new StockMaintenance({
      db: tx,
      audit: new AuditService(new MemoryAudit()),
      now: () => T0,
    });
    const service = new StockOverviewService({
      store: createPrismaStockOverviewStore(tx),
      maintenance,
      readSettings: async () => settings,
    });
    return fn({ tx, ctx, service, add: (spec = {}) => addStockProduct(tx, ctx, spec) });
  });
}

describe("drepturi: starea cu products.read, cantitățile cu inventory.read", () => {
  it("Manager și Depozit văd cantitățile; Editorul vede starea fără cantități; Suport și Contabil nu au acces; anonimul nu", async () => {
    await withStock(async (h) => {
      const { productId } = await h.add({ step: "2,5", variants: [{ physical: "100" }] });
      for (const role of ["owner", "admin", "manager", "warehouse"]) {
        const view = await h.service.forProduct(roleSubject(role), productId);
        expect(view?.canSeeQuantities, role).toBe(true);
        expect(view?.rows[0]?.physical, role).not.toBeNull();
        expect(view?.summary.quantity, role).not.toBeNull();
      }
      const editor = await h.service.forProduct(roleSubject("editor"), productId);
      expect(editor?.canSeeQuantities).toBe(false);
      expect(editor?.rows[0]).toMatchObject({
        physical: null,
        available: null,
        availableSteps: null,
        state: "in_stock",
      });
      expect(editor?.summary).toMatchObject({ quantity: null, state: "in_stock" });
      for (const role of ["support", "accountant"]) {
        await expect(
          h.service.forProduct(roleSubject(role), productId),
          role,
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          h.service.summaries(roleSubject(role), [productId]),
          role,
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      await expect(h.service.forProduct(null, productId)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
      await expect(h.service.summaries(null, [productId])).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });
  });

  it("nicio cantitate nu iese pentru Editor nici prin rezumatul din listă", async () => {
    await withStock(async (h) => {
      const { productId } = await h.add({ variants: [{ physical: "77" }, { physical: "3" }] });
      const map = await h.service.summaries(roleSubject("editor"), [productId]);
      const summary = map.get(productId);
      expect(summary).toMatchObject({ state: "in_stock", variantCount: 2, quantity: null });
      const manager = (await h.service.summaries(roleSubject("manager"), [productId])).get(
        productId,
      );
      expect(manager?.quantity && formatQuantity(manager.quantity.available as Quantity)).toBe(
        "80",
      );
    });
  });
});

describe("termenul de livrare cu proveniența lui", () => {
  it("produsul, apoi brandul, apoi setarea globală; numele brandului vine cu termenul lui", async () => {
    await withStock(async (h) => {
      const brand = await h.tx.brand.create({
        data: { slug: `b-${h.ctx.tag}`, name: "Brand Termen", defaultLeadTimeDays: 8 },
      });
      const none = await h.add({ manageStock: false, stockStatus: "onbackorder" });
      const viaBrand = await h.add({ manageStock: false, stockStatus: "onbackorder" });
      const own = await h.add({ manageStock: false, stockStatus: "onbackorder" });
      await h.tx.product.update({ where: { id: viaBrand.productId }, data: { brandId: brand.id } });
      await h.tx.product.update({
        where: { id: own.productId },
        data: { brandId: brand.id, leadTimeDays: 3 },
      });
      const manager = roleSubject("manager");

      const a = await h.service.forProduct(manager, none.productId);
      expect(a?.leadTime).toMatchObject({
        productDays: null,
        brandDays: null,
        brandName: null,
        globalDays: 14,
        effectiveDays: 14,
        origin: "global",
      });
      const b = await h.service.forProduct(manager, viaBrand.productId);
      expect(b?.leadTime).toMatchObject({
        productDays: null,
        brandDays: 8,
        brandName: "Brand Termen",
        effectiveDays: 8,
        origin: "brand",
      });
      const c = await h.service.forProduct(manager, own.productId);
      expect(c?.leadTime).toMatchObject({
        productDays: 3,
        brandDays: 8,
        effectiveDays: 3,
        origin: "product",
      });
      expect(c?.summary).toMatchObject({ state: "on_order", leadTimeDays: 3 });
    });
  });

  it("0 zile pe produs bate brandul și e o valoare, nu «lipsă»", async () => {
    await withStock(async (h) => {
      const brand = await h.tx.brand.create({
        data: { slug: `b-${h.ctx.tag}`, name: "Brand", defaultLeadTimeDays: 8 },
      });
      const p = await h.add({ manageStock: false, stockStatus: "onbackorder" });
      await h.tx.product.update({
        where: { id: p.productId },
        data: { brandId: brand.id, leadTimeDays: 0 },
      });
      const view = await h.service.forProduct(roleSubject("manager"), p.productId);
      expect(view?.leadTime).toMatchObject({ effectiveDays: 0, origin: "product" });
    });
  });
});

describe("valorile efective pe variantă", () => {
  it("o variantă poate coborî gestiunea: produsul gestionat are o variantă negestionată; rezumatul devine «mixed»", async () => {
    await withStock(async (h) => {
      const { productId, variants } = await h.add({
        variants: [{ physical: "10" }, { physical: "10" }],
      });
      await h.tx.productVariant.update({
        where: { id: variants[1]?.id as string },
        data: { manageStock: false, stockStatus: "outofstock" },
      });
      const view = await h.service.forProduct(roleSubject("manager"), productId);
      expect(view?.rows.map((r) => r.kind)).toEqual(["managed", "unmanaged"]);
      expect(view?.rows[1]).toMatchObject({
        state: "unavailable",
        stockStatus: "outofstock",
        physical: null,
      });
      expect(view?.summary).toMatchObject({ kind: "mixed", state: "in_stock" });
    });
  });

  it("produs digital: În stoc, fără cantități; produs negestionat: doar starea aleasă", async () => {
    await withStock(async (h) => {
      const digital = await h.add({
        type: "digital",
        manageStock: false,
        variants: [{ physical: null }],
      });
      const unmanaged = await h.add({
        manageStock: false,
        stockStatus: "outofstock",
        variants: [{ physical: null }],
      });
      const m = roleSubject("manager");
      expect((await h.service.forProduct(m, digital.productId))?.summary).toMatchObject({
        kind: "digital",
        state: "in_stock",
        quantity: null,
      });
      expect((await h.service.forProduct(m, unmanaged.productId))?.summary).toMatchObject({
        kind: "unmanaged",
        state: "unavailable",
        quantity: null,
      });
      // ZERO rânduri de stoc la negestionat: citirea nu creează nimic
      expect(
        await h.tx.inventoryItem.count({ where: { variantId: { in: h.ctx.variantIds } } }),
      ).toBe(0);
    });
  });

  it("gestionat dar încă neinventariat: semnalat, cantitate zero", async () => {
    await withStock(async (h) => {
      const { productId } = await h.add({ variants: [{ physical: null }] });
      const view = await h.service.forProduct(roleSubject("manager"), productId);
      expect(view?.summary.notInventoried).toBe(true);
      expect(view?.rows[0]).toMatchObject({ inventoried: false });
    });
  });
});

describe("produse inexistente sau șterse", () => {
  it("forProduct întoarce null; summaries le omite; o listă goală nu interoghează", async () => {
    await withStock(async (h) => {
      const m = roleSubject("manager");
      expect(await h.service.forProduct(m, "nu-exista")).toBeNull();
      const { productId } = await h.add({ variants: [{ physical: "5" }] });
      await h.tx.product.update({ where: { id: productId }, data: { deletedAt: new Date() } });
      expect(await h.service.forProduct(m, productId)).toBeNull();
      const map = await h.service.summaries(m, [productId, "nu-exista"]);
      expect(map.size).toBe(0);
      expect((await h.service.summaries(m, [])).size).toBe(0);
    });
  });

  it("rezumatele pentru mai multe produse deodată, fiecare cu starea lui", async () => {
    await withStock(async (h) => {
      const a = await h.add({ variants: [{ physical: "50" }] });
      const b = await h.add({ variants: [{ physical: "0" }] });
      const c = await h.add({ manageStock: false, stockStatus: "onbackorder" });
      const map = await h.service.summaries(roleSubject("manager"), [
        a.productId,
        b.productId,
        c.productId,
      ]);
      expect(map.get(a.productId)?.state).toBe("in_stock");
      expect(map.get(b.productId)?.state).toBe("unavailable");
      expect(map.get(c.productId)).toMatchObject({ state: "on_order", leadTimeDays: 14 });
    });
  });
});
