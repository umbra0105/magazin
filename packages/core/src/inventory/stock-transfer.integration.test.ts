import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { MAX_QUANTITY, parseQuantity, type Quantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import type { KeyValueCache } from "../cache/read-through";
import { FeatureFlagService } from "../features/feature-flag-service";
import { createPrismaFeatureFlagStore } from "../features/prisma-store";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockService } from "./stock-service";
import {
  StockTransferService,
  TRANSFER_REF_TYPE,
  type TransferStockResult,
} from "./stock-transfer";

/**
 * Faza 5, punctul 13b: transferul între depozite pe baza reală (tranzacție anulată), cu steagul real și rolurile din seed.
 * Regulile: sursa dă doar ce e DISPONIBIL (fizic − angajat − rezervat − tampon), pasul de vânzare și unitatea variantei se
 * respectă, depozitele dezactivate și cel identic se refuză, ambele mișcări poartă aceeași referință, orice eroare anulează
 * tot. Nu presupune seed: depozitul implicit îl creează `runBaseSeed`, restul testul.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const NOW = new Date("2099-03-01T12:00:00Z");
const HOUR = 3_600_000;

const noCache: KeyValueCache = {
  get: async () => null,
  set: async () => "OK",
  del: async () => 1,
};

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  /** Depozitul sursă (cel al contextului) */
  from: string;
  /** Depozitul destinație */
  to: string;
  service: StockTransferService;
  stock: StockService;
  audit: AuditService;
  clock: { now: Date };
  setFlag: (enabled: boolean) => Promise<void>;
  as: (role: string) => Promise<PermissionSubject>;
  manager: PermissionSubject;
  product: (spec?: ProductSpec) => Promise<{ productId: string; id: string; sku: string }>;
  item: (variantId: string, warehouseId: string) => Promise<ItemSnapshot | null>;
  transfer: (
    variantId: string,
    quantity: string,
    over?: Record<string, unknown>,
  ) => Promise<TransferStockResult>;
}

interface ItemSnapshot {
  physical: bigint;
  committed: bigint;
  reserved: bigint;
}

async function withTransfer<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const flags = new FeatureFlagService(createPrismaFeatureFlagStore(tx as PrismaClient), noCache);
    await flags.setEnabled("multiWarehouse", true);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const clock = { now: NOW };
    const ctx = await createStockContext(tx);
    const other = await tx.warehouse.create({
      data: { code: `w_${ctx.tag}b`, name: `Destinație ${ctx.tag}` },
    });
    const service = new StockTransferService({
      db: tx,
      audit,
      isEnabled: () => flags.isEnabled("multiWarehouse"),
      now: () => clock.now,
    });
    const stock = new StockService({ db: tx, now: () => clock.now });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `tr-${role}-${n++}`, name: role, email: `tr-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subiect lipsă");
      return subject;
    };
    const manager = await as("manager");
    const harness: Harness = {
      tx,
      ctx,
      from: ctx.warehouseId,
      to: other.id,
      service,
      stock,
      audit,
      clock,
      setFlag: (enabled) => flags.setEnabled("multiWarehouse", enabled),
      as,
      manager,
      product: async (spec) => {
        const created = await addStockProduct(tx, ctx, spec);
        return {
          productId: created.productId,
          id: created.variants[0]!.id,
          sku: created.variants[0]!.sku,
        };
      },
      item: async (variantId, warehouseId) =>
        tx.inventoryItem.findUnique({
          where: { variantId_warehouseId: { variantId, warehouseId } },
          select: { physical: true, committed: true, reserved: true },
        }),
      transfer: (variantId, quantity, over = {}) =>
        service.transfer(manager, {
          variantId,
          fromWarehouseId: ctx.warehouseId,
          toWarehouseId: other.id,
          quantity,
          ...over,
        }),
    };
    return fn(harness);
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; details?: unknown };
  }
  return {};
}

describe("transferul reușit", () => {
  it("scade în sursă, adaugă în destinație (rândul se creează), două mișcări legate de aceeași referință", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      expect(await h.item(v.id, h.to)).toBeNull();

      const result = await h.transfer(v.id, "4", { note: "mutat în magazin" });

      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("6") });
      expect(await h.item(v.id, h.to)).toMatchObject({
        physical: q("4"),
        committed: 0n,
        reserved: 0n,
      });
      expect(result).toMatchObject({
        variantId: v.id,
        fromWarehouseId: h.from,
        toWarehouseId: h.to,
        quantity: q("4"),
        from: { physicalBefore: q("10"), physicalAfter: q("6") },
        to: { physicalBefore: q("0"), physicalAfter: q("4") },
      });

      const moves = await h.tx.stockMovement.findMany({
        where: { refType: TRANSFER_REF_TYPE, refId: result.transferId },
        orderBy: { kind: "asc" },
      });
      expect(moves.map((m) => m.kind)).toEqual(["transfer_in", "transfer_out"]);
      const [moveIn, moveOut] = moves;
      expect(moveOut).toMatchObject({
        id: result.from.movementId,
        variantId: v.id,
        warehouseId: h.from,
        deltaPhysical: -q("4"),
        deltaCommitted: 0n,
        physicalAfter: q("6"),
        effectiveAt: NOW,
        note: "mutat în magazin",
        reason: null,
        actorId: h.manager.userId,
        actorLabel: h.manager.email,
      });
      expect(moveIn).toMatchObject({
        id: result.to.movementId,
        variantId: v.id,
        warehouseId: h.to,
        deltaPhysical: q("4"),
        physicalAfter: q("4"),
        effectiveAt: NOW,
        note: "mutat în magazin",
        actorId: h.manager.userId,
      });
      expect(moveIn?.refId).toBe(moveOut?.refId);
      expect(moveIn?.refType).toBe(moveOut?.refType);
      // coerența contoarelor pe ambele depozite
      expect(await h.stock.checkConsistency(v.id, h.from)).toMatchObject({ ok: true });
      expect(await h.stock.checkConsistency(v.id, h.to)).toMatchObject({ ok: true });
    });
  });

  it("adaugă peste stocul existent din destinație; nota e opțională (nulă în mișcări)", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.tx.inventoryItem.create({
        data: { variantId: v.id, warehouseId: h.to, physical: q("3") },
      });
      const result = await h.transfer(v.id, "2");
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("5") });
      expect(result.to).toMatchObject({ physicalBefore: q("3"), physicalAfter: q("5") });
      const notes = await h.tx.stockMovement.findMany({
        where: { refType: TRANSFER_REF_TYPE, refId: result.transferId },
        select: { note: true },
      });
      expect(notes.map((n) => n.note)).toEqual([null, null]);
    });
  });

  it("nu atinge alte variante și nici rezervările / angajările din sursă", async () => {
    await withTransfer(async (h) => {
      const a = await h.product({ variants: [{ physical: "10" }] });
      const b = await h.product({ variants: [{ physical: "7" }] });
      await h.stock.reserve(
        { refType: "order", refId: `r-${h.ctx.tag}` },
        [{ variantId: a.id, warehouseId: h.from, quantity: q("2") }],
        new Date(NOW.getTime() + HOUR),
      );
      await h.transfer(a.id, "3");
      expect(await h.item(b.id, h.from)).toMatchObject({ physical: q("7") });
      expect(await h.item(b.id, h.to)).toBeNull();
      expect(await h.item(a.id, h.from)).toMatchObject({ physical: q("7"), reserved: q("2") });
      expect(await h.stock.checkConsistency(a.id, h.from)).toMatchObject({ ok: true });
    });
  });

  it("auditul păstrează actorul, înainte și după pe ambele depozite și avertismentele", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      const result = await h.transfer(v.id, "4", { note: "mutare" });
      const rows = await h.audit.list({ entity: "stock_transfer", entityId: result.transferId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "stock.transfer",
        actorId: h.manager.userId,
        outcome: "success",
        before: {
          variantId: v.id,
          from: { warehouseId: h.from, physical: "10" },
          to: { warehouseId: h.to, physical: "0" },
        },
        after: {
          quantity: "4",
          note: "mutare",
          from: { warehouseId: h.from, physical: "6" },
          to: { warehouseId: h.to, physical: "4" },
          warnings: [],
        },
      });
    });
  });
});

describe("sursa dă doar ce e DISPONIBIL, nu tot ce e fizic", () => {
  it("rezervat și angajat nu se mută: disponibil = fizic − angajat − rezervat", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.stock.reserve(
        { refType: "order", refId: `r-${h.ctx.tag}` },
        [{ variantId: v.id, warehouseId: h.from, quantity: q("3") }],
        new Date(NOW.getTime() + HOUR),
      );
      await h.stock.commitDirect({ refType: "order", refId: `c-${h.ctx.tag}` }, [
        { variantId: v.id, warehouseId: h.from, quantity: q("2") },
      ]);
      // disponibil = 10 − 3 − 2 = 5
      const refused = await errorOf(h.transfer(v.id, "6"));
      expect(refused.code).toBe("STOCK_TRANSFER_INSUFFICIENT");
      expect(refused.details).toMatchObject({ available: "5", requested: "6" });
      expect(await h.item(v.id, h.from)).toMatchObject({
        physical: q("10"),
        reserved: q("3"),
        committed: q("2"),
      });
      expect(await h.item(v.id, h.to)).toBeNull();
      expect(await h.tx.stockMovement.count({ where: { refType: TRANSFER_REF_TYPE } })).toBe(0);

      // exact disponibilul trece
      await h.transfer(v.id, "5");
      expect(await h.item(v.id, h.from)).toMatchObject({
        physical: q("5"),
        reserved: q("3"),
        committed: q("2"),
      });
      expect(await h.stock.checkConsistency(v.id, h.from)).toMatchObject({ ok: true });
      // acum disponibilul e 0
      expect(await codeOf(h.transfer(v.id, "1"))).toBe("STOCK_TRANSFER_INSUFFICIENT");
    });
  });

  it("tamponul de siguranță rămâne în sursă", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10", buffer: "3" }] });
      expect(await codeOf(h.transfer(v.id, "8"))).toBe("STOCK_TRANSFER_INSUFFICIENT");
      await h.transfer(v.id, "7");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("3") });
    });
  });

  it("o rezervare expirată nu mai blochează marfa (se eliberează sub blocare, ca la rezervare)", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.stock.reserve(
        { refType: "order", refId: `x-${h.ctx.tag}` },
        [{ variantId: v.id, warehouseId: h.from, quantity: q("6") }],
        new Date(NOW.getTime() + 15 * 60_000),
      );
      expect(await codeOf(h.transfer(v.id, "8"))).toBe("STOCK_TRANSFER_INSUFFICIENT");
      h.clock.now = new Date(NOW.getTime() + HOUR);
      await h.transfer(v.id, "8");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("2"), reserved: 0n });
      expect(await h.stock.checkConsistency(v.id, h.from)).toMatchObject({ ok: true });
    });
  });

  it("sursa fără rând de stoc: stoc insuficient (disponibil 0) și nicio urmă în destinație", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: null }] });
      const refused = await errorOf(h.transfer(v.id, "1"));
      expect(refused.code).toBe("STOCK_TRANSFER_INSUFFICIENT");
      expect(refused.details).toMatchObject({ available: "0" });
      expect(await h.item(v.id, h.to)).toBeNull();
      expect(await h.item(v.id, h.from)).toBeNull();
    });
  });
});

describe("pasul de vânzare și unitatea variantei", () => {
  it("cantitatea e multiplu de pas; restul nevandabil nu se mută (liner: pas 41,25, stoc 100)", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ step: "41,25", variants: [{ physical: "100" }] });
      expect((await errorOf(h.transfer(v.id, "17,5"))).code).toBeDefined();
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("100") });
      await h.transfer(v.id, "41,25");
      await h.transfer(v.id, "41,25");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("17,5") });
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("82,5") });
      // au rămas 17,5 mp: mai puțin de un pas, deci nu se mai poate muta nimic
      expect(await codeOf(h.transfer(v.id, "41,25"))).toBe("STOCK_TRANSFER_INSUFFICIENT");
      expect(await codeOf(h.transfer(v.id, "17,5"))).not.toBe("NO_ERROR");
    });
  });

  it("pas 0,3: 0,9 trece, 0,4 nu; zero și negativ nu", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ step: "0,3", variants: [{ physical: "10" }] });
      await h.transfer(v.id, "0,9");
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("0,9") });
      expect((await errorOf(h.transfer(v.id, "0,4"))).code).toBeDefined();
      expect((await errorOf(h.transfer(v.id, "0"))).code).toBeDefined();
      expect((await errorOf(h.transfer(v.id, "-0,3"))).code).toBeDefined();
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("0,9") });
    });
  });

  it("unitatea «buc» (nulă) nu primește zecimale: «1,5» → STOCK_TRANSFER_PRECISION", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      expect(await codeOf(h.transfer(v.id, "1,5"))).toBe("STOCK_TRANSFER_PRECISION");
      await h.transfer(v.id, "2");
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("2") });
    });
  });

  it("pasul propriu al variantei bate pe cel al produsului", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ step: "2,5", variants: [{ physical: "20" }] });
      await h.tx.productVariant.update({ where: { id: v.id }, data: { saleStep: 50000 } });
      expect((await errorOf(h.transfer(v.id, "2,5"))).code).toBeDefined();
      await h.transfer(v.id, "5");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("15") });
    });
  });
});

describe("depozitele", () => {
  it("același depozit → STOCK_TRANSFER_SAME_WAREHOUSE, nimic scris", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      expect(await codeOf(h.transfer(v.id, "1", { toWarehouseId: h.from }))).toBe(
        "STOCK_TRANSFER_SAME_WAREHOUSE",
      );
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("10") });
      expect(await h.tx.stockMovement.count({ where: { refType: TRANSFER_REF_TYPE } })).toBe(0);
    });
  });

  it("depozit dezactivat (sursă sau destinație) → STOCK_TRANSFER_WAREHOUSE_INACTIVE; reactivat, merge", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.tx.warehouse.update({ where: { id: h.to }, data: { isActive: false } });
      expect(await codeOf(h.transfer(v.id, "1"))).toBe("STOCK_TRANSFER_WAREHOUSE_INACTIVE");
      await h.tx.warehouse.update({ where: { id: h.to }, data: { isActive: true } });
      await h.tx.warehouse.update({ where: { id: h.from }, data: { isActive: false } });
      expect(await codeOf(h.transfer(v.id, "1"))).toBe("STOCK_TRANSFER_WAREHOUSE_INACTIVE");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("10") });
      expect(await h.item(v.id, h.to)).toBeNull();
      await h.tx.warehouse.update({ where: { id: h.from }, data: { isActive: true } });
      await h.transfer(v.id, "1");
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("1") });
    });
  });

  it("depozit inexistent (sursă sau destinație) → STOCK_NO_WAREHOUSE", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      expect(await codeOf(h.transfer(v.id, "1", { toWarehouseId: "nu-exista" }))).toBe(
        "STOCK_NO_WAREHOUSE",
      );
      expect(await codeOf(h.transfer(v.id, "1", { fromWarehouseId: "nu-exista" }))).toBe(
        "STOCK_NO_WAREHOUSE",
      );
    });
  });

  it("depozitul implicit poate fi sursă sau destinație", async () => {
    await withTransfer(async (h) => {
      const main = await h.tx.warehouse.findFirstOrThrow({ where: { isDefault: true } });
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.transfer(v.id, "3", { toWarehouseId: main.id });
      expect(await h.item(v.id, main.id)).toMatchObject({ physical: q("3") });
      await h.transfer(v.id, "1", { fromWarehouseId: main.id, toWarehouseId: h.from });
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("8") });
    });
  });
});

describe("variante care nu au stoc de mutat", () => {
  it("produs negestionat, digital sau variantă inexistentă → refuz cu cod stabil", async () => {
    await withTransfer(async (h) => {
      const unmanaged = await h.product({ manageStock: false, variants: [{ physical: null }] });
      const digital = await h.product({ type: "digital", variants: [{ physical: null }] });
      expect(await codeOf(h.transfer(unmanaged.id, "1"))).toBe("STOCK_NOT_MANAGED");
      expect(await codeOf(h.transfer(digital.id, "1"))).toBe("STOCK_NOT_MANAGED");
      expect(await codeOf(h.transfer("nu-exista", "1"))).toBe("STOCK_VARIANT_NOT_FOUND");
    });
  });
});

describe("orice eroare anulează tot", () => {
  it("destinația ar depăși plafonul: sursa rămâne neatinsă, nicio mișcare, niciun audit", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.tx.inventoryItem.create({
        data: { variantId: v.id, warehouseId: h.to, physical: MAX_QUANTITY - 5000n },
      });
      expect(await codeOf(h.transfer(v.id, "1"))).toBe("STOCK_TRANSFER_OVERFLOW");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("10") });
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: MAX_QUANTITY - 5000n });
      expect(await h.tx.stockMovement.count({ where: { refType: TRANSFER_REF_TYPE } })).toBe(0);
      expect(await h.audit.list({ entity: "stock_transfer" })).toEqual([]);
    });
  });

  it("un eșec la scrierea celei de-a doua mișcări (declanșator de probă în bază) anulează și scăderea din sursă", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      // declanșator creat în tranzacția testului (anulată la final): refuză mișcarea de intrare, deci eșecul vine DUPĂ ce
      // sursa a fost scăzută, destinația crescută și mișcarea de ieșire scrisă
      const name = `test_fail_in_${h.ctx.tag}`;
      await h.tx.$executeRawUnsafe(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'transfer_in' THEN RAISE EXCEPTION 'eșec simulat la mișcarea de intrare'; END IF; RETURN NEW; END $$`,
      );
      await h.tx.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE INSERT ON stock_movement FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      await expect(h.transfer(v.id, "4")).rejects.toThrow("eșec simulat");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("10") });
      expect(await h.item(v.id, h.to)).toBeNull();
      expect(await h.tx.stockMovement.count({ where: { refType: TRANSFER_REF_TYPE } })).toBe(0);
      expect(await h.audit.list({ entity: "stock_transfer" })).toEqual([]);
    });
  });
});

describe("avertismentul despre poza SmartBill", () => {
  it("fără poze în niciun depozit → fără avertismente", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      expect((await h.transfer(v.id, "1")).warnings).toEqual([]);
    });
  });

  it("depozitul sursă primește poze SmartBill → avertisment pe sursă, cu numele depozitului", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.tx.stockSnapshot.create({
        data: { warehouseId: h.from, takenAt: new Date(NOW.getTime() - HOUR), source: "import" },
      });
      const result = await h.transfer(v.id, "1");
      expect(result.warnings).toEqual([
        {
          kind: "snapshot_overwrites_source",
          warehouseId: h.from,
          warehouseName: `Depozit ${h.ctx.tag}`,
        },
      ]);
      const [audited] = await h.audit.list({
        entity: "stock_transfer",
        entityId: result.transferId,
      });
      expect(audited?.after).toMatchObject({
        warnings: [{ kind: "snapshot_overwrites_source", warehouseId: h.from }],
      });
    });
  });

  it("destinația (sau ambele) primesc poze → avertisment pe fiecare", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      for (const warehouseId of [h.from, h.to]) {
        await h.tx.stockSnapshot.create({
          data: { warehouseId, takenAt: new Date(NOW.getTime() - HOUR), source: "import" },
        });
      }
      const kinds = (await h.transfer(v.id, "1")).warnings.map((w) => [w.kind, w.warehouseId]);
      expect(kinds).toEqual([
        ["snapshot_overwrites_source", h.from],
        ["snapshot_overwrites_destination", h.to],
      ]);
    });
  });
});

describe("steagul real și drepturile cu rolurile din seed", () => {
  it("steagul oprit → FEATURE_DISABLED, nimic scris; pornit din nou → merge", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "10" }] });
      await h.setFlag(false);
      expect(await codeOf(h.transfer(v.id, "1"))).toBe("FEATURE_DISABLED");
      expect(await h.item(v.id, h.from)).toMatchObject({ physical: q("10") });
      expect(await h.item(v.id, h.to)).toBeNull();
      await h.setFlag(true);
      await h.transfer(v.id, "1");
      expect(await h.item(v.id, h.to)).toMatchObject({ physical: q("1") });
    });
  });

  it("Owner, Admin, Manager și Depozit pot; Editor, Suport și Contabil nu; la refuz nimic nu se mișcă", async () => {
    await withTransfer(async (h) => {
      const v = await h.product({ variants: [{ physical: "20" }] });
      for (const role of ["owner", "admin", "manager", "warehouse"]) {
        const subject = await h.as(role);
        const result = await h.service.transfer(subject, {
          variantId: v.id,
          fromWarehouseId: h.from,
          toWarehouseId: h.to,
          quantity: "1",
        });
        expect(result.quantity, role).toBe(q("1"));
      }
      const before = await h.item(v.id, h.from);
      for (const role of ["editor", "support", "accountant"]) {
        const subject = await h.as(role);
        expect(
          await codeOf(
            h.service.transfer(subject, {
              variantId: v.id,
              fromWarehouseId: h.from,
              toWarehouseId: h.to,
              quantity: "1",
            }),
          ),
          role,
        ).toBe("AUTH_FORBIDDEN");
      }
      expect(await h.item(v.id, h.from)).toEqual(before);
    });
  });
});
