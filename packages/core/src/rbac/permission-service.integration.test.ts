import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction as rolledBack } from "../test-utils/rollback";
import { PermissionService } from "./permission-service";
import { can, hasAdminAccess } from "./can";
import { resolveSubject } from "./resolve-subject";

const db = getDb();

async function withUser<T>(
  roleKeys: string[],
  fn: (service: PermissionService, userId: string) => Promise<T>,
): Promise<T> {
  return rolledBack(db, async (tx) => {
    await runBaseSeed(tx);
    const user = await tx.user.create({
      data: { id: "rbac-u1", name: "Test", email: "rbac-u1@test.invalid" },
    });
    for (const key of roleKeys) {
      const role = await tx.role.findUniqueOrThrow({ where: { key } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    return fn(new PermissionService(tx), user.id);
  });
}

describe("PermissionService pe baza de test", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("Suport: poate rambursa, nu poate arhiva produse (permisiunile vin din DB)", async () => {
    await withUser(["support"], async (service, id) => {
      const subject = await service.loadSubject(id);
      expect(subject?.roles).toEqual(["support"]);
      expect(can(subject, "orders.refund")).toBe(true);
      expect(can(subject, "products.archive")).toBe(false);
    });
  });

  it("Owner: are tot", async () => {
    await withUser(["owner"], async (service, id) => {
      const subject = await service.loadSubject(id);
      expect(can(subject, "system.update")).toBe(true);
    });
  });

  it("client fără roluri: subiect fără acces în admin", async () => {
    await withUser([], async (service, id) => {
      const subject = await service.loadSubject(id);
      expect(subject?.roles).toEqual([]);
      expect(can(subject, "orders.read")).toBe(false);
    });
  });

  it("toate cele 7 roluri de sistem intră în admin (admin.access vine din seed)", async () => {
    for (const key of [
      "owner",
      "admin",
      "manager",
      "editor",
      "support",
      "warehouse",
      "accountant",
    ]) {
      await withUser([key], async (service, id) => {
        expect(hasAdminAccess(await service.loadSubject(id)), key).toBe(true);
      });
    }
  });

  it("un rol personalizat FĂRĂ admin.access nu intră în admin, deși are alte permisiuni", async () => {
    await rolledBack(db, async (tx) => {
      await runBaseSeed(tx);
      const user = await tx.user.create({
        data: { id: "rbac-u2", name: "Test", email: "rbac-u2@test.invalid" },
      });
      const role = await tx.role.create({ data: { key: "doar-comenzi", name: "Doar comenzi" } });
      const orders = await tx.permission.findUniqueOrThrow({ where: { key: "orders.read" } });
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId: orders.id } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      expect(subject?.permissions.has("orders.read")).toBe(true);
      expect(hasAdminAccess(subject)).toBe(false);
      expect(can(subject, "orders.read")).toBe(false);
    });
  });

  it("utilizator inexistent => null", async () => {
    await withUser([], async (service) => {
      expect(await service.loadSubject("nu-exista")).toBeNull();
    });
  });

  it("resolveSubject cu DB real: sesiune de admin veche de 9h e refuzată", async () => {
    await withUser(["manager"], async (service, id) => {
      const old = new Date(Date.now() - 9 * 3_600_000);
      const fresh = new Date(Date.now() - 1 * 3_600_000);
      const deps = { permissions: service, adminSessionHours: 8 };
      expect((await resolveSubject(deps, { userId: id, createdAt: old })).status).toBe(
        "admin-session-expired",
      );
      expect((await resolveSubject(deps, { userId: id, createdAt: fresh })).status).toBe("ok");
    });
  });
});
