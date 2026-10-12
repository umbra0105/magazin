import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { BrandingService } from "../branding/branding-service";
import { configFromPreset } from "../branding/presets";
import { createPrismaBrandingStore } from "../branding/prisma-store";
import { FeatureFlagService } from "../features/feature-flag-service";
import { createPrismaFeatureFlagStore } from "../features/prisma-store";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import { createWithPermission, OWNER_ROLE_KEY, type PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES, type PermissionKey } from "../rbac/catalog";
import { createPrismaSettingsStore } from "../settings/prisma-store";
import { SettingsService } from "../settings/settings-service";
import { createFakeCache } from "../test-utils/fake-cache";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createAdminWrites, recordDeniedAttempt } from "./admin-writes";

const db = getDb();
const APP_KEY = Buffer.alloc(32, 22).toString("base64");

/**
 * Matricea de securitate cap-coadă: fiecare scriere din admin × fiecare rol de sistem (plus clientul
 * fără roluri și vizitatorul neautentificat). Rezultatul așteptat vine din catalogul RBAC; pentru
 * fiecare refuz verificăm că nimic nu s-a modificat și că încercarea e în jurnal ca „denied”.
 */

interface WriteAction {
  /** Cheia acțiunii din jurnal (și din `actions.ts`). */
  action: string;
  permission: PermissionKey;
  /** O modificare reală (diferită de starea de pornire), ca să se vadă dacă a rulat. */
  changed: (tx: TestTx) => Promise<boolean>;
}

const ACTIONS: WriteAction[] = [
  {
    action: "settings.update",
    permission: "settings.write",
    changed: async (tx) =>
      (await tx.setting.findUnique({ where: { key: "general.storeName" } }))?.value === "Nume nou",
  },
  {
    action: "feature_flag.update",
    permission: "settings.write",
    changed: async (tx) =>
      (await tx.featureFlag.findUnique({ where: { key: "blog" } }))?.enabled === true,
  },
  {
    action: "branding.update",
    permission: "settings.write",
    changed: async (tx) => {
      const row = await tx.branding.findFirst();
      return JSON.stringify(row?.colors ?? null).includes("#aa00ff");
    },
  },
  {
    action: "integration.update",
    permission: "integrations.write",
    changed: async (tx) => (await tx.integration.count({ where: { provider: "sameday" } })) > 0,
  },
];

/** Citește din `actions.ts` perechea permisiune → acțiune, ca testul să nu poată diverge de cod. */
function actionsFromSource(): Map<string, string> {
  const file = resolve(__dirname, "../../../../apps/web/src/app/(admin)/admin/setari/actions.ts");
  const source = readFileSync(file, "utf8");
  const pattern = /withPermission\(\s*"([\w.]+)"[\s\S]*?\{\s*action:\s*"([\w.]+)"/g;
  return new Map([...source.matchAll(pattern)].map((m) => [m[2] as string, m[1] as string]));
}

type Subject = PermissionSubject | null;
const subjects: { label: string; subject: Subject }[] = [
  ...DEFAULT_ROLES.map((role) => ({
    label: `rol ${role.key}`,
    subject: {
      userId: `u-${role.key}`,
      email: `${role.key}@magazin.test`,
      roles: [role.key],
      permissions: new Set<string>(role.key === OWNER_ROLE_KEY ? [] : role.permissions),
    },
  })),
  {
    // Client: fără roluri; chiar cu permisiunile „lipite” pe subiect, nu intră.
    label: "client fără roluri",
    subject: {
      userId: "u-client",
      email: "client@magazin.test",
      roles: [],
      permissions: new Set<string>(["admin.access", "settings.write", "integrations.write"]),
    },
  },
  { label: "neautentificat", subject: null },
];

const expectedAllowed = (subject: Subject, permission: PermissionKey): boolean => {
  if (!subject || subject.roles.length === 0) return false;
  if (subject.roles.includes(OWNER_ROLE_KEY)) return true;
  const role = DEFAULT_ROLES.find((r) => r.key === subject.roles[0]);
  const granted = role?.permissions ?? [];
  return granted.includes("admin.access") && granted.includes(permission);
};

function setup(tx: TestTx, subject: Subject) {
  const client = tx as unknown as PrismaClient;
  const cache = createFakeCache().cache;
  const audit = new AuditService(createPrismaAuditStore(tx));
  const settings = new SettingsService(createPrismaSettingsStore(client), cache);
  const flags = new FeatureFlagService(createPrismaFeatureFlagStore(client), cache);
  const branding = new BrandingService(createPrismaBrandingStore(client), cache);
  const integrations = new IntegrationService(createPrismaIntegrationStore(client), APP_KEY);
  const writes = createAdminWrites({ audit, settings, flags, branding, integrations });
  const withPermission = createWithPermission({
    getSubject: async () => subject,
    onDenied: (attempt) => recordDeniedAttempt(audit, attempt),
  });
  const actor = (s: PermissionSubject) => ({ id: s.userId, label: s.email });
  const base = configFromPreset("minimal");

  // Aceleași acțiuni ca în `actions.ts`, cu aceleași permisiuni (verificat mai jos din sursă).
  const run: Record<string, () => Promise<unknown>> = {
    "settings.update": () =>
      withPermission(
        "settings.write",
        async (_: void, s) =>
          writes.updateSetting({ key: "general.storeName", value: "Nume nou" }, actor(s)),
        { action: "settings.update", entity: "setting" },
      )(),
    "feature_flag.update": () =>
      withPermission(
        "settings.write",
        async (_: void, s) => writes.setFeatureFlag({ key: "blog", enabled: true }, actor(s)),
        { action: "feature_flag.update", entity: "feature_flag" },
      )(),
    "branding.update": () =>
      withPermission(
        "settings.write",
        async (_: void, s) =>
          writes.saveBranding(
            {
              ...base,
              colors: { ...base.colors, light: { ...base.colors.light, accent: "#aa00ff" } },
            },
            actor(s),
          ),
        { action: "branding.update", entity: "branding" },
      )(),
    "integration.update": () =>
      withPermission(
        "integrations.write",
        async (_: void, s) =>
          writes.saveIntegration(
            { type: "shipping", provider: "sameday", config: { region: "RO" } },
            actor(s),
          ),
        { action: "integration.update", entity: "integration" },
      )(),
  };
  return { settings, flags, branding, run };
}

describe("matricea de securitate: scrieri din admin × roluri (Postgres real)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("permisiunile folosite aici sunt exact cele din actions.ts", () => {
    const fromSource = actionsFromSource();
    expect([...fromSource.keys()].sort()).toEqual(ACTIONS.map((a) => a.action).sort());
    for (const a of ACTIONS) expect(fromSource.get(a.action)).toBe(a.permission);
  });

  for (const { label, subject } of subjects) {
    it(`${label}: poate doar ce are în catalog; refuzurile nu modifică nimic și se înregistrează`, async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { settings, flags, branding, run } = setup(tx, subject);
        await settings.set("general.storeName", "Nume vechi");
        await flags.setEnabled("blog", false);
        await branding.save(configFromPreset("minimal"));

        for (const a of ACTIONS) {
          const allowed = expectedAllowed(subject, a.permission);
          const attempt = run[a.action]?.();
          if (!attempt) throw new Error(`acțiune netestată: ${a.action}`);

          if (allowed) {
            await expect(attempt).resolves.toBeDefined();
            expect(await a.changed(tx), `${label} ar fi trebuit să modifice ${a.action}`).toBe(
              true,
            );
            const success = await tx.auditLog.findMany({
              where: { action: a.action, outcome: "success" },
            });
            expect(success).toHaveLength(1);
            expect(success[0]?.actorId).toBe(subject?.userId);
          } else {
            await expect(attempt).rejects.toBeInstanceOf(
              subject ? ForbiddenError : UnauthenticatedError,
            );
            expect(await a.changed(tx), `${label} NU trebuia să modifice ${a.action}`).toBe(false);
            const denied = await tx.auditLog.findMany({
              where: { action: a.action, outcome: "denied" },
            });
            expect(denied).toHaveLength(1);
            expect(denied[0]?.actorId ?? null).toBe(subject?.userId ?? null);
            expect(denied[0]?.after).toMatchObject({
              permission: a.permission,
              reason: subject ? "forbidden" : "unauthenticated",
            });
            expect(
              await tx.auditLog.count({ where: { action: a.action, outcome: "success" } }),
            ).toBe(0);
          }
        }
      });
    });
  }

  it("rolurile de sistem se împart exact pe cele două permisiuni de scriere", () => {
    const by = (permission: PermissionKey) =>
      subjects
        .filter((s) => expectedAllowed(s.subject, permission))
        .map((s) => s.label)
        .sort();
    // Owner are tot; Admin are settings.write dar nu integrations.write (vezi catalog).
    expect(by("integrations.write")).toEqual(["rol owner"]);
    expect(by("settings.write")).toContain("rol owner");
    expect(by("settings.write")).toContain("rol admin");
    expect(by("settings.write")).not.toContain("rol support");
    expect(by("settings.write")).not.toContain("client fără roluri");
  });
});
