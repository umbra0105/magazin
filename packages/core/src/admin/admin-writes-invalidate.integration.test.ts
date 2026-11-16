import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { ValidationError, runWithRequestContext } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { BrandingService } from "../branding/branding-service";
import { configFromPreset } from "../branding/presets";
import { createPrismaBrandingStore } from "../branding/prisma-store";
import { FeatureFlagService } from "../features/feature-flag-service";
import { createPrismaFeatureFlagStore } from "../features/prisma-store";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import { createPrismaSettingsStore } from "../settings/prisma-store";
import { SettingsService } from "../settings/settings-service";
import { STOREFRONT_CHROME_TAG } from "../storefront/revalidation";
import { createFakeCache } from "../test-utils/fake-cache";
import { inAuditScope } from "../test-utils/audit-baseline";
import type { TestTx } from "../test-utils/rollback";
import { createAdminWrites } from "./admin-writes";

const db = getDb();
afterAll(() => db.$disconnect());
const ACTOR = { id: "actor-1", label: "admin@magazin.test" };
const KEY = Buffer.alloc(32, 21).toString("base64");

function setup(tx: TestTx, invalidate: (tags: readonly string[]) => Promise<void> | void) {
  const client = tx as unknown as PrismaClient;
  const cache = createFakeCache().cache;
  const writes = createAdminWrites({
    audit: new AuditService(createPrismaAuditStore(tx)),
    settings: new SettingsService(createPrismaSettingsStore(client), cache),
    flags: new FeatureFlagService(createPrismaFeatureFlagStore(client), cache),
    branding: new BrandingService(createPrismaBrandingStore(client), cache),
    integrations: new IntegrationService(createPrismaIntegrationStore(client), KEY),
    invalidate,
  });
  return { writes };
}

const inContext = <T>(fn: () => Promise<T>) =>
  runWithRequestContext({ requestId: "req-invalidate-1234" }, fn);

describe("scrierile din admin invalidează cache-ul vitrinei (setări, flag-uri, branding)", () => {
  it("o setare salvată invalidează cadrul vitrinei și catalogul", async () => {
    await inAuditScope(db, async (tx) => {
      const invalidate = vi.fn();
      const { writes } = setup(tx, invalidate);
      await inContext(() =>
        writes.updateSetting({ key: "general.storeName", value: "Magazin Nou" }, ACTOR),
      );
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(new Set(invalidate.mock.calls[0]![0])).toEqual(
        new Set([STOREFRONT_CHROME_TAG, "catalog"]),
      );
    });
  });

  it("un flag schimbat invalidează (o pagină oprită nu rămâne servită din cache)", async () => {
    await inAuditScope(db, async (tx) => {
      const invalidate = vi.fn();
      const { writes } = setup(tx, invalidate);
      await inContext(() => writes.setFeatureFlag({ key: "blog", enabled: true }, ACTOR));
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate.mock.calls[0]![0]).toContain(STOREFRONT_CHROME_TAG);
    });
  });

  it("brandingul salvat invalidează cadrul vitrinei", async () => {
    await inAuditScope(db, async (tx) => {
      const invalidate = vi.fn();
      const { writes } = setup(tx, invalidate);
      await inContext(() => writes.saveBranding(configFromPreset("minimal"), ACTOR));
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate.mock.calls[0]![0]).toContain(STOREFRONT_CHROME_TAG);
    });
  });

  it("o scriere respinsă (valoare invalidă) nu invalidează nimic", async () => {
    await inAuditScope(db, async (tx) => {
      const invalidate = vi.fn();
      const { writes } = setup(tx, invalidate);
      await expect(
        inContext(() => writes.updateSetting({ key: "setare.inexistenta", value: 1 }, ACTOR)),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  it("un eșec al invalidării nu anulează scrierea", async () => {
    await inAuditScope(db, async (tx) => {
      const { writes } = setup(tx, () => {
        throw new Error("cache indisponibil");
      });
      await expect(
        inContext(() =>
          writes.updateSetting({ key: "general.storeName", value: "Alt Nume" }, ACTOR),
        ),
      ).resolves.toBeDefined();
    });
  });
});
