import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DEFAULT_ROLES, PERMISSION_KEYS } from "../rbac/catalog";
import { FEATURE_KEYS } from "../features/registry";
import { listSettingKeys } from "../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { runBaseSeed } from "./base-seed";

const db = getDb();

/** Golește tabelele de configurare DOAR în tranzacția de test (se anulează la final). */
async function emptyConfigTables(tx: TestTx) {
  await tx.userRole.deleteMany();
  await tx.rolePermission.deleteMany();
  await tx.role.deleteMany();
  await tx.permission.deleteMany();
  await tx.setting.deleteMany();
  await tx.featureFlag.deleteMany();
  await tx.branding.deleteMany();
}

describe("seed de bază (Postgres real, în tranzacție anulată)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("creează catalogul complet și rulează idempotent (a doua oară nu adaugă nimic)", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await emptyConfigTables(tx);
      const first = await runBaseSeed(tx);
      const counts = async () => ({
        permission: await tx.permission.count(),
        role: await tx.role.count(),
        rolePermission: await tx.rolePermission.count(),
        setting: await tx.setting.count(),
        featureFlag: await tx.featureFlag.count(),
        branding: await tx.branding.count(),
      });
      const afterFirst = await counts();
      const second = await runBaseSeed(tx);
      const afterSecond = await counts();
      return { first, second, afterFirst, afterSecond };
    });

    const expectedLinks = DEFAULT_ROLES.reduce((n, r) => n + r.permissions.length, 0);
    expect(out.afterFirst).toEqual({
      permission: PERMISSION_KEYS.length,
      role: DEFAULT_ROLES.length,
      rolePermission: expectedLinks,
      setting: listSettingKeys().length,
      featureFlag: FEATURE_KEYS.length,
      branding: 1,
    });
    expect(out.first.brandingCreated).toBe(true);
    expect(out.second).toEqual({
      permissions: 0,
      roles: 0,
      rolePermissions: 0,
      settings: 0,
      featureFlags: 0,
      brandingCreated: false,
    });
    expect(out.afterSecond).toEqual(out.afterFirst);
  });

  it("are products.cost.view (Owner, Admin, Manager, Contabil), toate flag-urile oprite, TVA 21% și țara RO", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await emptyConfigTables(tx);
      await runBaseSeed(tx);
      const withCostView = await tx.role.findMany({
        where: { permissions: { some: { permission: { key: "products.cost.view" } } } },
        select: { key: true },
      });
      const owner = await tx.role.findUniqueOrThrow({
        where: { key: "owner" },
        include: { permissions: true },
      });
      return {
        costViewRoles: withCostView.map((r) => r.key).sort(),
        ownerPermissions: owner.permissions.length,
        enabledFlags: await tx.featureFlag.count({ where: { enabled: true } }),
        tax: (await tx.setting.findUniqueOrThrow({ where: { key: "tax.standardRate" } })).value,
        countries: (
          await tx.setting.findUniqueOrThrow({ where: { key: "regional.allowedCountries" } })
        ).value,
      };
    });
    expect(out.costViewRoles).toEqual(["accountant", "admin", "manager", "owner"]);
    expect(out.ownerPermissions).toBe(PERMISSION_KEYS.length);
    expect(out.enabledFlags).toBe(0);
    expect(out.tax).toBe(21);
    expect(out.countries).toEqual(["RO"]);
  });

  it("nu suprascrie ce s-a schimbat din admin și nu scoate permisiuni acordate", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await emptyConfigTables(tx);
      await runBaseSeed(tx);
      await tx.setting.update({ where: { key: "tax.standardRate" }, data: { value: 19 } });
      await tx.featureFlag.update({ where: { key: "blog" }, data: { enabled: true } });
      await tx.branding.update({ where: { id: "default" }, data: { preset: "bold" } });
      const support = await tx.role.findUniqueOrThrow({ where: { key: "support" } });
      const extra = await tx.permission.findUniqueOrThrow({ where: { key: "reports.read" } });
      await tx.rolePermission.create({ data: { roleId: support.id, permissionId: extra.id } });

      await runBaseSeed(tx);
      return {
        tax: (await tx.setting.findUniqueOrThrow({ where: { key: "tax.standardRate" } })).value,
        blog: (await tx.featureFlag.findUniqueOrThrow({ where: { key: "blog" } })).enabled,
        preset: (await tx.branding.findUniqueOrThrow({ where: { id: "default" } })).preset,
        supportLinks: await tx.rolePermission.count({ where: { roleId: support.id } }),
      };
    });
    expect(out.tax).toBe(19);
    expect(out.blog).toBe(true);
    expect(out.preset).toBe("bold");
    const supportDefault = DEFAULT_ROLES.find((r) => r.key === "support")?.permissions.length ?? 0;
    expect(out.supportLinks).toBe(supportDefault + 1);
  });

  it("aplică o permisiune nouă pe un rol existent, fără să scoată sau să schimbe altceva", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      await emptyConfigTables(tx);
      await runBaseSeed(tx);
      // Simulează o bază seed-uită înainte de modificarea mapării: Manager fără cost.view.
      const manager = await tx.role.findUniqueOrThrow({ where: { key: "manager" } });
      const costView = await tx.permission.findUniqueOrThrow({
        where: { key: "products.cost.view" },
      });
      await tx.rolePermission.delete({
        where: { roleId_permissionId: { roleId: manager.id, permissionId: costView.id } },
      });
      const total = await tx.rolePermission.count();
      const before = await tx.rolePermission.count({ where: { roleId: manager.id } });

      const result = await runBaseSeed(tx);
      return {
        added: result.rolePermissions,
        total: await tx.rolePermission.count(),
        expectedTotal: total + 1,
        managerBefore: before,
        managerAfter: await tx.rolePermission.count({ where: { roleId: manager.id } }),
      };
    });
    expect(out.added).toBe(1);
    expect(out.total).toBe(out.expectedTotal);
    expect(out.managerAfter).toBe(out.managerBefore + 1);
  });

  it("nu creează utilizatori, conturi sau parole", async () => {
    const out = await inRolledBackTransaction(db, async (tx) => {
      const before = { users: await tx.user.count(), accounts: await tx.account.count() };
      await emptyConfigTables(tx);
      await runBaseSeed(tx);
      return { before, users: await tx.user.count(), accounts: await tx.account.count() };
    });
    expect(out.users).toBe(out.before.users);
    expect(out.accounts).toBe(out.before.accounts);
  });
});
