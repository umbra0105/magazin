import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { runBaseSeed } from "./base-seed";

const db = getDb();

describe("seed de bază pe o instalare existentă (fără admin.access)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("adaugă admin.access la cele 7 roluri, o singură dată, fără să scoată nimic acordat", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      // Simulează baza de dinaintea schimbării: permisiunea și legăturile ei nu există.
      await tx.permission.delete({ where: { key: "admin.access" } });
      // O permisiune acordată manual de un admin unui rol de sistem trebuie să rămână.
      const support = await tx.role.findUniqueOrThrow({ where: { key: "support" } });
      const extra = await tx.permission.findUniqueOrThrow({ where: { key: "products.archive" } });
      await tx.rolePermission.create({ data: { roleId: support.id, permissionId: extra.id } });

      const first = await runBaseSeed(tx);
      const second = await runBaseSeed(tx);
      const withAccess = await tx.rolePermission.count({
        where: { permission: { key: "admin.access" } },
      });
      const kept = await tx.rolePermission.count({
        where: { roleId: support.id, permissionId: extra.id },
      });
      return { first, second, withAccess, kept };
    });
    expect(out.first.permissions).toBe(1);
    expect(out.first.rolePermissions).toBe(DEFAULT_ROLES.length);
    expect(out.second.permissions).toBe(0);
    expect(out.second.rolePermissions).toBe(0);
    expect(out.withAccess).toBe(DEFAULT_ROLES.length);
    expect(out.kept).toBe(1);
  });

  it("products.export: o instalare veche primește permisiunea la rularea seed-ului, doar la Manager, Admin, Owner", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      // Simulează baza de dinaintea schimbării: permisiunea și legăturile ei nu există.
      await tx.permission.delete({ where: { key: "products.export" } });
      const first = await runBaseSeed(tx);
      const second = await runBaseSeed(tx);
      const holders = await tx.rolePermission.findMany({
        where: { permission: { key: "products.export" } },
        select: { role: { select: { key: true } } },
      });
      return { first, second, roles: holders.map((h) => h.role.key).sort() };
    });
    expect(out.first.permissions).toBe(1);
    expect(out.second.permissions).toBe(0);
    expect(out.second.rolePermissions).toBe(0);
    // Depozit, Editor, Suport și Contabil au products.read sau cost, dar nu pot exporta catalogul
    expect(out.roles).toEqual(["admin", "manager", "owner"]);
  });
});
