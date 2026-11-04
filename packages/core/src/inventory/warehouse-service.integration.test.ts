import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { parseQuantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import type { KeyValueCache } from "../cache/read-through";
import { FeatureFlagService } from "../features/feature-flag-service";
import { createPrismaFeatureFlagStore } from "../features/prisma-store";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { addStockProduct, createStockContext } from "../test-utils/stock-fixtures";
import {
  WarehouseCodeTakenError,
  WarehouseService,
  type WarehouseRecord,
} from "./warehouse-service";
import { createPrismaWarehouseStore } from "./warehouse-store";

/**
 * Faza 5, punctul 13a: serviciul de depozite pe baza reală (tranzacție anulată), cu steagul `multiWarehouse` citit de la
 * serviciul real de flag-uri (fără cache, ca schimbarea să se vadă imediat) și cu rolurile din seed. Nu presupune seed:
 * depozitul implicit îl creează `runBaseSeed`.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

/** Fără cache: fiecare citire a steagului merge în bază */
const noCache: KeyValueCache = {
  get: async () => null,
  set: async () => "OK",
  del: async () => 1,
};

async function withWarehouses<T>(
  fn: (c: {
    tx: TestTx;
    service: WarehouseService;
    flags: FeatureFlagService;
    audit: AuditService;
    as: (role: string) => Promise<PermissionSubject>;
  }) => Promise<T>,
  options: { enabled?: boolean } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const flags = new FeatureFlagService(createPrismaFeatureFlagStore(tx as PrismaClient), noCache);
    await flags.setEnabled("multiWarehouse", options.enabled ?? true);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const service = new WarehouseService({
      store: createPrismaWarehouseStore(tx),
      audit,
      isEnabled: () => flags.isEnabled("multiWarehouse"),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `wh-${role}-${n++}`, name: role, email: `wh-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subiect lipsă");
      return subject;
    };
    return fn({ tx, service, flags, audit, as });
  });
}

const rejection = async (
  fn: () => Promise<unknown>,
): Promise<{ code?: string; details?: Record<string, unknown> } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; details?: Record<string, unknown> };
  }
};

describe("steagul real din baza de date", () => {
  it("oprit: tot refuzat, nimic scris; pornit: merge; oprit din nou: refuzat din nou (fără cache)", async () => {
    await withWarehouses(
      async ({ tx, service, flags, as }) => {
        const manager = await as("manager");
        const before = await tx.warehouse.count();
        expect((await rejection(() => service.list(manager)))?.code).toBe("FEATURE_DISABLED");
        expect((await rejection(() => service.create(manager, { name: "Cluj" })))?.code).toBe(
          "FEATURE_DISABLED",
        );
        expect(await tx.warehouse.count()).toBe(before);

        await flags.setEnabled("multiWarehouse", true);
        const created = await service.create(manager, { name: "Cluj" });
        expect(created.code).toBe("cluj");

        await flags.setEnabled("multiWarehouse", false);
        expect((await rejection(() => service.deactivate(manager, created.id)))?.code).toBe(
          "FEATURE_DISABLED",
        );
        expect((await tx.warehouse.findUniqueOrThrow({ where: { id: created.id } })).isActive).toBe(
          true,
        );
      },
      { enabled: false },
    );
  });

  it("un steag lipsă din baza de date înseamnă oprit", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      await tx.featureFlag.deleteMany({ where: { key: "multiWarehouse" } });
      const manager = await as("manager");
      expect((await rejection(() => service.list(manager)))?.code).toBe("FEATURE_DISABLED");
    });
  });
});

describe("creare, redenumire, dezactivare pe baza reală", () => {
  it("ciclul complet: rândul din bază se schimbă, auditul păstrează actorul și înainte/după", async () => {
    await withWarehouses(async ({ tx, service, audit, as }) => {
      const manager = await as("manager");
      const created = await service.create(manager, { name: "Magazin Cluj" });
      const row = await tx.warehouse.findUniqueOrThrow({ where: { id: created.id } });
      expect(row).toMatchObject({
        code: "magazin_cluj",
        name: "Magazin Cluj",
        isDefault: false,
        isActive: true,
      });

      await service.rename(manager, created.id, { name: "Magazin Cluj-Napoca" });
      await service.deactivate(manager, created.id);
      await service.activate(manager, created.id);

      const after = await tx.warehouse.findUniqueOrThrow({ where: { id: created.id } });
      expect(after).toMatchObject({
        code: "magazin_cluj",
        name: "Magazin Cluj-Napoca",
        isActive: true,
      });
      const actions = (await audit.list({ entity: "warehouse", entityId: created.id }))
        .map((r) => [r.action, r.actorId, r.outcome])
        .reverse();
      expect(actions).toEqual([
        ["warehouse.create", manager.userId, "success"],
        ["warehouse.rename", manager.userId, "success"],
        ["warehouse.deactivate", manager.userId, "success"],
        ["warehouse.activate", manager.userId, "success"],
      ]);
      const rename = (await audit.list({ entity: "warehouse", entityId: created.id })).find(
        (r) => r.action === "warehouse.rename",
      );
      expect(rename?.before).toEqual({ name: "Magazin Cluj" });
      expect(rename?.after).toEqual({ name: "Magazin Cluj-Napoca" });
    });
  });

  it("lista: implicitul primul, apoi după nume, cu numărul de rânduri de stoc; listActive fără cele dezactivate", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const before = (await service.list(manager)).map((w) => w.name);
      const zimbru = await service.create(manager, { name: "Zimbru" });
      const albina = await service.create(manager, { name: "Albina" });
      await service.deactivate(manager, albina.id);
      const all = await service.list(manager);
      expect(all[0]?.isDefault).toBe(true);
      expect(all.map((w) => w.name).filter((n) => !before.includes(n))).toEqual([
        "Albina",
        "Zimbru",
      ]);
      expect((await service.listActive(manager)).map((w) => w.id)).not.toContain(albina.id);
      expect((await service.listActive(manager)).map((w) => w.id)).toContain(zimbru.id);
      expect(all.every((w) => w.stockedItems >= 0)).toBe(true);
      expect(await tx.warehouse.count({ where: { isDefault: true } })).toBe(1);
    });
  });

  it("două nume cu același cod derivat primesc coduri diferite în bază", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const a = await service.create(manager, { name: "Șură" });
      const b = await service.create(manager, { name: "Sura" });
      expect([a.code, b.code]).toEqual(["sura", "sura_2"]);
      expect(await tx.warehouse.count({ where: { code: { in: ["sura", "sura_2"] } } })).toBe(2);
    });
  });

  it("indexul unic al codului respinge un cod luat, iar depozitul îl traduce în WarehouseCodeTakenError", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const created = await service.create(manager, { name: "Cluj" });
      const store = createPrismaWarehouseStore(tx);
      // o eroare de bază de date strică tranzacția: o izolăm într-un SAVEPOINT
      await tx.$executeRawUnsafe("SAVEPOINT warehouse_code");
      await expect(store.create({ code: created.code, name: "Alt nume" })).rejects.toBeInstanceOf(
        WarehouseCodeTakenError,
      );
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT warehouse_code");
      expect(await tx.warehouse.count({ where: { code: created.code } })).toBe(1);
    });
  });
});

describe("depozitul implicit", () => {
  it("se redenumește, dar nu se dezactivează (serviciul refuză, iar baza are CHECK-ul ei)", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const main = (await service.list(manager)).find((w) => w.isDefault) as WarehouseRecord;
      const renamed = await service.rename(manager, main.id, { name: "Depozit central" });
      expect(renamed).toMatchObject({ name: "Depozit central", code: main.code, isDefault: true });

      expect((await rejection(() => service.deactivate(manager, main.id)))?.code).toBe(
        "WAREHOUSE_DEFAULT_PROTECTED",
      );
      expect((await tx.warehouse.findUniqueOrThrow({ where: { id: main.id } })).isActive).toBe(
        true,
      );

      // și direct în bază, ocolind serviciul
      await tx.$executeRawUnsafe("SAVEPOINT default_active");
      await expect(
        tx.warehouse.update({ where: { id: main.id }, data: { isActive: false } }),
      ).rejects.toThrow();
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT default_active");
    });
  });

  it("rămâne exact unul, oricâte depozite se creează", async () => {
    await withWarehouses(async ({ tx, service, as }) => {
      const manager = await as("manager");
      for (const name of ["A", "B", "C"]) await service.create(manager, { name });
      expect(await tx.warehouse.count({ where: { isDefault: true } })).toBe(1);
    });
  });
});

describe("un depozit cu stoc nu se dezactivează", () => {
  async function stockedWarehouse(
    c: Parameters<Parameters<typeof withWarehouses>[0]>[0],
    manager: PermissionSubject,
  ) {
    const warehouse = await c.service.create(manager, { name: "Cluj" });
    const ctx = await createStockContext(c.tx);
    ctx.warehouseId = warehouse.id;
    const product = await addStockProduct(c.tx, ctx, { variants: [{ physical: "5" }] });
    const variantId = product.variants[0]!.id;
    return { warehouse, variantId };
  }

  it("cantitate fizică nenulă → WAREHOUSE_HAS_STOCK cu numărul de rânduri; după golire se dezactivează", async () => {
    await withWarehouses(async (c) => {
      const manager = await c.as("manager");
      const { warehouse, variantId } = await stockedWarehouse(c, manager);
      const error = await rejection(() => c.service.deactivate(manager, warehouse.id));
      expect(error?.code).toBe("WAREHOUSE_HAS_STOCK");
      expect(error?.details?.["stockedItems"]).toBe(1);
      expect((await c.service.list(manager)).find((w) => w.id === warehouse.id)?.stockedItems).toBe(
        1,
      );

      await c.tx.inventoryItem.updateMany({
        where: { variantId, warehouseId: warehouse.id },
        data: { physical: parseQuantity("0") },
      });
      const off = await c.service.deactivate(manager, warehouse.id);
      expect(off.isActive).toBe(false);
    });
  });

  it("doar «rezervat» nenul sau doar «angajat» nenul blochează și ele dezactivarea", async () => {
    for (const counter of ["reserved", "committed"] as const) {
      await withWarehouses(async (c) => {
        const manager = await c.as("manager");
        const { warehouse, variantId } = await stockedWarehouse(c, manager);
        await c.tx.inventoryItem.updateMany({
          where: { variantId, warehouseId: warehouse.id },
          data: { physical: parseQuantity("5"), [counter]: parseQuantity("1") },
        });
        // fizicul se golește, dar a rămas «rezervat» / «angajat» (fizicul < ce e ținut: stare permisă de bază)
        await c.tx.$executeRawUnsafe(
          `UPDATE inventory_item SET physical = 0 WHERE "variantId" = '${variantId}' AND "warehouseId" = '${warehouse.id}'`,
        );
        expect(
          (await rejection(() => c.service.deactivate(manager, warehouse.id)))?.code,
          counter,
        ).toBe("WAREHOUSE_HAS_STOCK");
      });
    }
  });

  it("stocul altui depozit nu blochează dezactivarea unuia gol", async () => {
    await withWarehouses(async (c) => {
      const manager = await c.as("manager");
      await stockedWarehouse(c, manager);
      const empty = await c.service.create(manager, { name: "Gol" });
      const off = await c.service.deactivate(manager, empty.id);
      expect(off.isActive).toBe(false);
    });
  });
});

describe("drepturi cu rolurile din seed", () => {
  it("Owner, Admin, Manager și Depozit scriu; Editor, Suport și Contabil nu; nimic nu s-a scris la refuz", async () => {
    await withWarehouses(async ({ tx, service, audit, as }) => {
      for (const role of ["owner", "admin", "manager", "warehouse"]) {
        const subject = await as(role);
        const created = await service.create(subject, { name: `Din ${role}` });
        expect(created.name).toBe(`Din ${role}`);
      }
      const writes = (await audit.list({ entity: "warehouse" })).length;
      const rows = await tx.warehouse.count();
      for (const role of ["editor", "support", "accountant"]) {
        const subject = await as(role);
        expect((await rejection(() => service.create(subject, { name: "X" })))?.code, role).toBe(
          "AUTH_FORBIDDEN",
        );
        expect((await rejection(() => service.list(subject)))?.code, role).toBe("AUTH_FORBIDDEN");
      }
      expect(await tx.warehouse.count()).toBe(rows);
      expect((await audit.list({ entity: "warehouse" })).length).toBe(writes);
    });
  });
});
