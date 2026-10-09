import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { revokeRolePermission } from "./revoke";

const db = getDb();

describe("rbac:revoke (scoatere explicită a unei permisiuni)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("baza veche (Suport cu orders.refund): simularea nu schimbă nimic, --apply scoate, seed-ul nu o readuce", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      // Starea unei baze create înainte de schimbare: Suport are orders.refund.
      const support = await tx.role.findUniqueOrThrow({ where: { key: "support" } });
      const refund = await tx.permission.findUniqueOrThrow({ where: { key: "orders.refund" } });
      await tx.rolePermission.create({ data: { roleId: support.id, permissionId: refund.id } });
      const has = () =>
        tx.rolePermission.count({ where: { roleId: support.id, permissionId: refund.id } });

      const seedDoesNotRemove = await (async () => {
        await runBaseSeed(tx);
        return has();
      })();
      const dry = await revokeRolePermission(tx, "support", "orders.refund", false);
      const afterDry = await has();
      const applied = await revokeRolePermission(tx, "support", "orders.refund", true);
      const afterApply = await has();
      const again = await revokeRolePermission(tx, "support", "orders.refund", true);
      await runBaseSeed(tx);
      const afterSeed = await has();
      return { seedDoesNotRemove, dry, afterDry, applied, afterApply, again, afterSeed };
    });
    expect(out.seedDoesNotRemove).toBe(1); // dovada: seed-ul singur nu scoate
    expect(out.dry).toEqual({ status: "would-remove", affectedUsers: 0, stillInCatalog: false });
    expect(out.afterDry).toBe(1);
    expect(out.applied.status).toBe("removed");
    expect(out.afterApply).toBe(0);
    expect(out.again.status).toBe("not-granted");
    expect(out.afterSeed).toBe(0);
  });

  it("avertizează când permisiunea mai e în catalog (seed-ul ar readuce-o)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      const r = await revokeRolePermission(tx, "manager", "orders.refund", false);
      expect(r.status).toBe("would-remove");
      expect(r.stillInCatalog).toBe(true);
    });
  });

  it("rol sau permisiune inexistente", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      expect((await revokeRolePermission(tx, "nu-exista", "orders.read", true)).status).toBe(
        "unknown-role",
      );
      expect((await revokeRolePermission(tx, "support", "nu.exista", true)).status).toBe(
        "unknown-permission",
      );
    });
  });
});
