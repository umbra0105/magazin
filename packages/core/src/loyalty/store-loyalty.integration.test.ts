import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { createPrismaSettingsStore } from "../settings/prisma-store";
import { SettingsService } from "../settings/settings-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { readLoyaltySettings } from "./loyalty-settings";
import { seedStoreLoyalty } from "./store-loyalty";

/**
 * Seed-ul magazinului (Faza 15b): prima rulare pornește programul cu tratamentul `base_reduced`; rulările următoare nu
 * suprascriu nimic din ce a schimbat adminul. Pachetul (fără acest seed) rămâne cu programul oprit și tratamentul gol.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const clean = <T>(fn: (tx: TestTx) => Promise<T>) =>
  inRolledBackTransaction(db, async (tx) => {
    await tx.setting.deleteMany({ where: { group: "loyalty" } });
    await tx.featureFlag.deleteMany({ where: { key: "loyalty" } });
    return fn(tx);
  });

describe("seed-ul de loialitate al magazinului", () => {
  it("fără el (pachetul): program oprit, tratament gol", async () => {
    await clean(async (tx) => {
      expect(await readLoyaltySettings(tx)).toMatchObject({
        enabled: false,
        vatMode: null,
        active: false,
      });
    });
  });

  it("în ordinea reală de instalare (db:seed, apoi db:seed:store) programul pornește", async () => {
    await clean(async (tx) => {
      // db:seed scrie câte un rând pentru FIECARE setare, cu valoarea implicită
      await runBaseSeed(tx);
      expect(await tx.setting.count({ where: { key: "loyalty.enabled" } })).toBe(1);
      expect(await seedStoreLoyalty(tx)).toBe(true);
      expect(await readLoyaltySettings(tx)).toMatchObject({
        featureOn: true,
        enabled: true,
        vatMode: "base_reduced",
        redeemAvailable: true,
      });
    });
  });

  it("prima rulare pornește programul cu base_reduced", async () => {
    await clean(async (tx) => {
      expect(await seedStoreLoyalty(tx)).toBe(true);
      expect(await readLoyaltySettings(tx)).toMatchObject({
        featureOn: true,
        enabled: true,
        vatMode: "base_reduced",
        active: true,
        redeemAvailable: true,
      });
    });
  });

  it("a doua rulare nu suprascrie ce a schimbat adminul (tratament golit, program oprit)", async () => {
    await clean(async (tx) => {
      await seedStoreLoyalty(tx);
      await tx.setting.deleteMany({ where: { key: "loyalty.vatMode" } });
      await tx.setting.update({ where: { key: "loyalty.enabled" }, data: { value: false } });
      await tx.featureFlag.update({ where: { key: "loyalty" }, data: { enabled: false } });
      // ambele seed-uri rulate din nou (de exemplu după o actualizare)
      await runBaseSeed(tx);
      expect(await seedStoreLoyalty(tx)).toBe(false);
      expect(await readLoyaltySettings(tx)).toMatchObject({
        featureOn: false,
        enabled: false,
        vatMode: null,
      });
    });
  });
});

describe("golirea unei setări din admin", () => {
  it("tratamentul și plafonul se pot goli prin serviciul de setări, nu doar prin ștergerea rândului", async () => {
    await clean(async (tx) => {
      const cache = { get: async () => null, set: async () => "OK", del: async () => 0 };
      const settings = new SettingsService(
        createPrismaSettingsStore(tx as unknown as PrismaClient),
        cache,
      );
      await settings.set("loyalty.vatMode", "base_reduced");
      await settings.set("loyalty.maxRedeemPercent", 50);
      await settings.set("loyalty.vatMode", null);
      await settings.set("loyalty.maxRedeemPercent", null);
      expect(await readLoyaltySettings(tx)).toMatchObject({
        vatMode: null,
        maxRedeemPercent: null,
      });
    });
  });
});
