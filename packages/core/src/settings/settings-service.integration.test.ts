import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
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
});
