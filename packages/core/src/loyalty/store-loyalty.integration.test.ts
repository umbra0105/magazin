import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
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
      expect(await seedStoreLoyalty(tx)).toBe(false);
      expect(await readLoyaltySettings(tx)).toMatchObject({
        featureOn: false,
        enabled: false,
        vatMode: null,
      });
    });
  });
});
