import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  runWithRequestContext,
} from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { BrandingService } from "../branding/branding-service";
import { configFromPreset } from "../branding/presets";
import { createPrismaBrandingStore } from "../branding/prisma-store";
import { FeatureFlagService } from "../features/feature-flag-service";
import { createPrismaFeatureFlagStore } from "../features/prisma-store";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import { createWithPermission, type PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { createPrismaSettingsStore } from "../settings/prisma-store";
import { SettingsService } from "../settings/settings-service";
import { createFakeCache } from "../test-utils/fake-cache";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createAdminWrites, recordDeniedAttempt } from "./admin-writes";

const db = getDb();
const APP_KEY = Buffer.alloc(32, 21).toString("base64");

const ACTOR = { id: "actor-1", label: "admin@magazin.test" };
const REQUEST_ID = "req-audit-12345678";

/** Servicii reale (Postgres), pe tranzacția de test; cache fals în memorie. */
function setup(tx: TestTx) {
  const client = tx as unknown as PrismaClient;
  const cache = createFakeCache().cache;
  const audit = new AuditService(createPrismaAuditStore(tx));
  const settings = new SettingsService(createPrismaSettingsStore(client), cache);
  const flags = new FeatureFlagService(createPrismaFeatureFlagStore(client), cache);
  const branding = new BrandingService(createPrismaBrandingStore(client), cache);
  const integrations = new IntegrationService(createPrismaIntegrationStore(client), APP_KEY);
  const writes = createAdminWrites({ audit, settings, flags, branding, integrations });
  return { audit, settings, flags, branding, integrations, writes, tx };
}

const rows = (tx: TestTx, action: string) =>
  tx.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

const inContext = <T>(fn: () => Promise<T>) => runWithRequestContext({ requestId: REQUEST_ID }, fn);

const subjectFor = (roleKey: string): PermissionSubject => {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set(role?.permissions ?? []),
  };
};

describe("scrieri din admin cu audit (Postgres real, în tranzacție anulată)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("setare: actor, requestId, rezultat, entitate, doar valoarea schimbată (înainte/după)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { writes, settings } = setup(tx);
      await settings.set("general.storeName", "Magazin Vechi");

      await inContext(() =>
        writes.updateSetting({ key: "general.storeName", value: "Magazin Nou" }, ACTOR),
      );
      expect(await settings.get("general.storeName")).toBe("Magazin Nou");

      const [row] = await rows(tx, "settings.update");
      expect(row).toMatchObject({
        actorId: ACTOR.id,
        actorLabel: ACTOR.label,
        action: "settings.update",
        entity: "setting",
        entityId: "general.storeName",
        outcome: "success",
        requestId: REQUEST_ID,
        before: { "general.storeName": "Magazin Vechi" },
        after: { "general.storeName": "Magazin Nou" },
      });
    });
  });

  it("o setare neschimbată sau invalidă nu scrie nimic în jurnal", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { writes, settings } = setup(tx);
      await settings.set("general.storeName", "Același");

      await writes.updateSetting({ key: "general.storeName", value: "Același" }, ACTOR);
      expect(await rows(tx, "settings.update")).toHaveLength(0);

      await expect(
        writes.updateSetting({ key: "nu.exista", value: 1 }, ACTOR),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        writes.updateSetting({ key: "tax.standardRate", value: 500 }, ACTOR),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await rows(tx, "settings.update")).toHaveLength(0);
      expect(await settings.get("tax.standardRate")).toBe(21); // valoarea veche a rămas
    });
  });

  it("flag: înregistrează doar schimbarea (fals → adevărat); a doua oară nu mai scrie", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { writes, flags } = setup(tx);
      await flags.setEnabled("blog", false);

      await inContext(() => writes.setFeatureFlag({ key: "blog", enabled: true }, ACTOR));
      await writes.setFeatureFlag({ key: "blog", enabled: true }, ACTOR);

      const logged = await rows(tx, "feature_flag.update");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        entity: "feature_flag",
        entityId: "blog",
        outcome: "success",
        requestId: REQUEST_ID,
        before: { enabled: false },
        after: { enabled: true },
      });
    });
  });

  it("branding: în jurnal apare DOAR culoarea schimbată, nu toată configurația", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { writes, branding } = setup(tx);
      const base = configFromPreset("minimal");
      await branding.save(base);

      const changed = {
        ...base,
        colors: { ...base.colors, light: { ...base.colors.light, accent: "#aa00ff" } },
      };
      const result = await writes.saveBranding(changed, ACTOR);
      expect(result.config.colors.light.accent).toBe("#aa00ff");

      const [row] = await rows(tx, "branding.update");
      expect(row?.before).toEqual({ "colors.light.accent": base.colors.light.accent });
      expect(row?.after).toEqual({ "colors.light.accent": "#aa00ff" });
      expect(JSON.stringify(row)).not.toContain(base.colors.light.bg); // culorile nemodificate lipsesc
    });
  });

  describe("integrări: nicio valoare sensibilă în audit", () => {
    const secrets = {
      apiKey: "sk_live_TOPSECRET_" + randomBytes(6).toString("hex"),
      password: "Parola-SMTP-" + randomBytes(6).toString("hex"),
    };

    it("credențialele apar doar ca nume de cheie ([modificat]/[ascuns]); în DB sunt criptate", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes, integrations } = setup(tx);

        await inContext(() =>
          writes.saveIntegration(
            {
              type: "payment",
              provider: "netopia",
              credentials: secrets,
              config: { mode: "live" },
              isActive: true,
            },
            ACTOR,
          ),
        );

        const [row] = await rows(tx, "integration.update");
        expect(row).toMatchObject({
          actorId: ACTOR.id,
          entity: "integration",
          entityId: "payment:netopia",
          outcome: "success",
          requestId: REQUEST_ID,
        });
        const text = JSON.stringify(row);
        // Nicio valoare, nici sufix mascat (****abcd), nici hash, nicăieri în rând.
        for (const secret of Object.values(secrets)) {
          expect(text).not.toContain(secret);
          expect(text).not.toContain(secret.slice(-4));
        }
        expect(text).not.toContain("****");
        expect(text).not.toMatch(/v1:[A-Za-z0-9_-]+:/); // nici textul criptat
        expect(row?.after).toMatchObject({
          authFields: ["apiKey", "password"],
          authFieldsChanged: ["apiKey", "password"],
          isActive: true,
          "config.mode": "live",
        });

        // În baza de date credențialele sunt criptate, iar serviciul le poate decripta.
        const stored = await tx.integration.findFirstOrThrow({
          where: { type: "payment", provider: "netopia" },
        });
        expect(stored.credentials).toMatch(/^v1:/);
        expect(stored.credentials).not.toContain(secrets.apiKey);
        expect(await integrations.getCredentials("payment", "netopia")).toEqual(secrets);
      });
    });

    it("la modificări, doar ce s-a schimbat: o schimbare de config nu atinge credențialele", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes } = setup(tx);
        await writes.saveIntegration(
          { type: "payment", provider: "netopia", credentials: secrets, config: { mode: "test" } },
          ACTOR,
        );
        await writes.saveIntegration(
          { type: "payment", provider: "netopia", config: { mode: "live" } },
          ACTOR,
        );

        const logged = await rows(tx, "integration.update");
        expect(logged).toHaveLength(2);
        expect(logged[1]?.before).toEqual({ "config.mode": "test" });
        expect(logged[1]?.after).toEqual({ "config.mode": "live" });
        expect(JSON.stringify(logged[1])).not.toContain("authFields");
      });
    });

    it("înlocuirea credențialelor: cheia scoasă apare ca dispărută, fără valori", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes } = setup(tx);
        await writes.saveIntegration(
          { type: "email", provider: "smtp", credentials: { password: secrets.password } },
          ACTOR,
        );
        await writes.saveIntegration(
          { type: "email", provider: "smtp", credentials: { apiKey: secrets.apiKey } },
          ACTOR,
        );
        const [, second] = await rows(tx, "integration.update");
        expect(second?.before).toEqual({
          authFields: ["password"],
          authFieldsChanged: [],
        });
        expect(second?.after).toEqual({
          authFields: ["apiKey"],
          authFieldsChanged: ["apiKey"],
        });
        const text = JSON.stringify(second);
        expect(text).not.toContain(secrets.password);
        expect(text).not.toContain(secrets.apiKey);
      });
    });

    it("o valoare sensibilă pusă din greșeală în config e mascată de AuditService (după numele cheii)", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes } = setup(tx);
        const leak = "tok_" + randomBytes(8).toString("hex");
        await writes.saveIntegration(
          { type: "shipping", provider: "sameday", config: { apiToken: leak, region: "RO" } },
          ACTOR,
        );
        const [row] = await rows(tx, "integration.update");
        expect(JSON.stringify(row)).not.toContain(leak);
        expect(row?.after).toMatchObject({ "config.region": "RO" });
      });
    });
  });

  describe("încercări refuzate", () => {
    it("fără permisiune: acțiunea NU rulează, nimic nu se modifică, încercarea se înregistrează ca „denied”", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes, audit } = setup(tx);
        const withPermission = createWithPermission({
          getSubject: async () => subjectFor("support"),
          onDenied: (attempt) => recordDeniedAttempt(audit, attempt),
          getRequestId: async () => REQUEST_ID,
        });
        let handlerRan = false;
        const attacker = "sk_live_" + randomBytes(8).toString("hex");
        const saveIntegration = withPermission(
          "integrations.write",
          async (input: { credentials: Record<string, string> }, subject) => {
            handlerRan = true;
            await writes.saveIntegration(
              { type: "payment", provider: "netopia", credentials: input.credentials },
              { id: subject.userId, label: subject.email },
            );
          },
          { action: "integration.update", entity: "integration" },
        );

        await expect(saveIntegration({ credentials: { apiKey: attacker } })).rejects.toBeInstanceOf(
          ForbiddenError,
        );

        expect(handlerRan).toBe(false);
        expect(await tx.integration.count({ where: { provider: "netopia" } })).toBe(0);
        const denied = await rows(tx, "integration.update");
        expect(denied).toHaveLength(1);
        expect(denied[0]).toMatchObject({
          actorId: "u-support",
          actorLabel: "support@magazin.test",
          entity: "integration",
          entityId: "integrations.write",
          outcome: "denied",
          requestId: REQUEST_ID,
          after: { permission: "integrations.write", reason: "forbidden" },
        });
        // Datele trimise cu încercarea nu ajung în jurnal.
        expect(JSON.stringify(denied[0])).not.toContain(attacker);
      });
    });

    it("neautentificat: refuzat și înregistrat fără actor", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { audit } = setup(tx);
        const withPermission = createWithPermission({
          getSubject: async () => null,
          onDenied: (attempt) => recordDeniedAttempt(audit, attempt),
        });
        const action = withPermission("settings.write", async () => "ok", {
          action: "settings.update",
          entity: "setting",
        });
        await expect(action(undefined)).rejects.toBeInstanceOf(UnauthenticatedError);
        const [row] = await rows(tx, "settings.update");
        expect(row).toMatchObject({
          actorId: null,
          outcome: "denied",
          after: { permission: "settings.write", reason: "unauthenticated" },
        });
      });
    });

    it("dacă înregistrarea refuzului eșuează, utilizatorul primește tot ForbiddenError", async () => {
      const withPermission = createWithPermission({
        getSubject: async () => subjectFor("support"),
        onDenied: async () => {
          throw new Error("jurnal indisponibil");
        },
      });
      const action = withPermission("settings.write", async () => "ok");
      await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("cu permisiune: reușita se înregistrează cu rezultatul „success”", async () => {
      await inRolledBackTransaction(db, async (tx) => {
        const { writes, audit, settings } = setup(tx);
        await settings.set("general.storeName", "Vechi");
        const withPermission = createWithPermission({
          getSubject: async () => subjectFor("admin"),
          onDenied: (attempt) => recordDeniedAttempt(audit, attempt),
          getRequestId: async () => REQUEST_ID,
        });
        const update = withPermission("settings.write", async (_: undefined, subject) =>
          writes.updateSetting(
            { key: "general.storeName", value: "Nou" },
            { id: subject.userId, label: subject.email },
          ),
        );
        await update(undefined);
        const [row] = await rows(tx, "settings.update");
        expect(row).toMatchObject({
          actorId: "u-admin",
          actorLabel: "admin@magazin.test",
          outcome: "success",
          requestId: REQUEST_ID,
        });
      });
    });
  });
});
