import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
import { removeE2eStockImports } from "../../test/e2e-support";
import { createPrismaSettingsStore } from "./prisma-store";
import { SETTINGS_CACHE_KEY, SettingsService } from "./settings-service";

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const db = getDb();
const service = new SettingsService(createPrismaSettingsStore(db), redis);

describe("SettingsService (Postgres + Redis reale)", () => {
  beforeEach(async () => {
    await db.setting.deleteMany();
    await redis.del(SETTINGS_CACHE_KEY);
  });

  afterAll(async () => {
    await db.setting.deleteMany();
    await redis.del(SETTINGS_CACHE_KEY);
    redis.disconnect();
    await db.$disconnect();
  });

  it("scrie în DB, cache-uiește în Redis și invalidează la scriere", async () => {
    expect(await service.get("tax.standardRate")).toBe(21);
    expect(await redis.exists(SETTINGS_CACHE_KEY)).toBe(1);

    await service.set("tax.standardRate", 19);
    expect(await redis.exists(SETTINGS_CACHE_KEY)).toBe(0);
    expect(await service.get("tax.standardRate")).toBe(19);

    const row = await db.setting.findUnique({ where: { key: "tax.standardRate" } });
    expect(row?.value).toBe(19);
    expect(row?.group).toBe("tax");
  });

  it("citește din cache chiar dacă DB-ul s-a schimbat pe lângă service", async () => {
    await service.set("general.storeName", "A");
    expect(await service.get("general.storeName")).toBe("A");
    await db.setting.update({ where: { key: "general.storeName" }, data: { value: "B" } });
    expect(await service.get("general.storeName")).toBe("A");
    await service.invalidate();
    expect(await service.get("general.storeName")).toBe("B");
  });

  /**
   * Incidentul CI din 2026-11-06: `removeE2eStockImports` șterge din SQL alegerea gestiunilor SmartBill, iar serverul E2E
   * continua s-o citească din cache-ul Redis al setărilor (TTL 300 s). La o reîncercare Playwright (CI are 2), testul
   * «import stoc la zi» vedea gestiunea ÎNCERCĂRII ANTERIOARE (tag aleator nou per worker) și pica, iar restul fișierului
   * serial rămânea nerulat. Ajutorul trebuie să invalideze cache-ul, ca `setE2eFeatureFlag` pentru flag-uri. Stă în acest
   * fișier pentru că folosește aceeași cheie Redis ca testele de mai sus (fișiere paralele ar șterge cheia una altuia).
   */
  it("setarea ștearsă direct din bază de ajutorul E2E nu mai e servită din cache", async () => {
    await service.set("inventory.smartbillWarehouses", ["Gestiune dintr-o încercare anterioară"]);
    expect(await service.get("inventory.smartbillWarehouses")).toEqual([
      "Gestiune dintr-o încercare anterioară",
    ]);
    expect(await redis.exists(SETTINGS_CACHE_KEY)).toBe(1);

    await removeE2eStockImports();

    expect(await db.setting.count({ where: { key: "inventory.smartbillWarehouses" } })).toBe(0);
    expect(await service.get("inventory.smartbillWarehouses")).toEqual([]);
  });
});
