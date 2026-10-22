import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { ProductService } from "../catalog/product-service";
import { createPrismaProductStore } from "../catalog/product-store";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { DEFAULT_MEASURE_UNIT_CODE } from "./constants";
import { MeasureUnitService } from "./measure-unit-service";
import { createPrismaMeasureUnitStore } from "./measure-unit-store";

/** Serviciul unităților pe baza reală: citire cu utilizare, «buc» protejată, unicitatea codului, audit. */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    units: MeasureUnitService;
    products: ProductService;
    as: (role: string) => Promise<PermissionSubject>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const units = new MeasureUnitService({ store: createPrismaMeasureUnitStore(tx), audit });
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => false,
      logger: createLogger({ destination: { write() {} } }),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `mu-${role}-${n++}`, name: role, email: `mu-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subiect lipsă");
      return subject;
    };
    return fn({ tx, units, products, as });
  });
}

const rejection = async (
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string };
  }
};

describe("unitățile de măsură pe baza reală", () => {
  it("lista arată unitățile de pornire și câte produse/variante le-au ales", async () => {
    await withServices(async ({ units, products, as }) => {
      const manager = await as("manager");
      const before = await units.list(manager);
      const codes = before.map((u) => u.code);
      for (const code of ["buc", "ml", "mp", "kg", "l", "sac", "rola", "cutie", "set", "pachet"]) {
        expect(codes, code).toContain(code);
      }
      const mp = before.find((u) => u.code === "mp");
      const created = await products.create(manager, {
        title: `Mozaic ${uid()}`,
        measureUnitId: mp?.id,
        variants: [
          { sku: `S-${uid()}`, price: 1000 },
          { sku: `S-${uid()}`, price: 1000, measureUnitId: mp?.id },
        ],
      });
      expect(created.product.measureUnitId).toBe(mp?.id);
      const after = await units.list(manager);
      expect(after.find((u) => u.code === "mp")).toMatchObject({
        productCount: (mp?.productCount ?? 0) + 1,
        variantCount: (mp?.variantCount ?? 0) + 1,
      });
    });
  });

  it("«buc» nu se dezactivează, nu își schimbă codul, nu primește zecimale și nu se șterge", async () => {
    await withServices(async ({ tx, units, as }) => {
      const manager = await as("manager");
      const buc = await tx.measureUnit.findUniqueOrThrow({
        where: { code: DEFAULT_MEASURE_UNIT_CODE },
      });
      for (const patch of [{ isActive: false }, { code: "bucata" }, { decimals: 1 }]) {
        expect(
          (await rejection(() => units.update(manager, buc.id, patch)))?.code,
          JSON.stringify(patch),
        ).toBe("MEASURE_UNIT_DEFAULT_PROTECTED");
      }
      const stored = await tx.measureUnit.findUniqueOrThrow({ where: { id: buc.id } });
      expect(stored).toMatchObject({ code: "buc", isActive: true, decimals: 0, isSystem: true });
      // numele se poate schimba
      expect((await units.update(manager, buc.id, { name: "Bucăți", symbol: "buc." })).name).toBe(
        "Bucăți",
      );
      // iar baza nu o lasă ștearsă oricum
      const error = await rejection(() => tx.measureUnit.delete({ where: { id: buc.id } }));
      expect(JSON.stringify(error) + String(error?.message)).toContain(
        "measure_unit_system_protected",
      );
    });
  });

  it("creare: cod unic, audit cu actorul; editare: audit cu diferențele", async () => {
    await withServices(async ({ tx, units, as }) => {
      const manager = await as("manager");
      const created = await units.create(manager, {
        code: "palet",
        name: "Palet",
        symbol: "palet",
        decimals: 0,
      });
      expect(created).toMatchObject({ code: "palet", isActive: true, isSystem: false });
      expect(
        (
          await rejection(() =>
            units.create(manager, { code: "palet", name: "Alt palet", symbol: "p" }),
          )
        )?.code,
      ).toBe("MEASURE_UNIT_CODE_CONFLICT");
      await units.update(manager, created.id, { name: "Palet EUR", smartbillName: "palet" });
      const rows = await tx.auditLog.findMany({
        where: { entity: "measure_unit", entityId: created.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => r.action)).toEqual(["measureUnit.create", "measureUnit.update"]);
      expect(rows[1]).toMatchObject({
        actorLabel: manager.email,
        before: { name: "Palet" },
        after: { name: "Palet EUR", smartbillName: "palet" },
      });
    });
  });

  it("drepturi: Editorul, Depozitul și Suportul citesc sau nu, dar nu scriu", async () => {
    await withServices(async ({ units, as }) => {
      const editor = await as("editor");
      expect((await units.list(editor)).length).toBeGreaterThan(5);
      expect(
        (await rejection(() => units.create(editor, { code: "x1", name: "X", symbol: "x" })))?.code,
      ).toBe("AUTH_FORBIDDEN");
      const owner = await as("owner");
      expect(
        await rejection(() => units.create(owner, { code: "x1", name: "X", symbol: "x" })),
      ).toBeNull();
    });
  });
});
