import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
import { createPrismaFeatureFlagStore } from "./prisma-store";
import { FEATURE_FLAGS_CACHE_KEY, FeatureFlagService } from "./feature-flag-service";

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const db = getDb();
const service = new FeatureFlagService(createPrismaFeatureFlagStore(db), redis);

describe("FeatureFlagService (Postgres + Redis reale)", () => {
  beforeEach(async () => {
    await db.featureFlag.deleteMany();
    await redis.del(FEATURE_FLAGS_CACHE_KEY);
  });

  afterAll(async () => {
    await db.featureFlag.deleteMany();
    await redis.del(FEATURE_FLAGS_CACHE_KEY);
    redis.disconnect();
    await db.$disconnect();
  });

  it("scrie în DB, cache-uiește în Redis și invalidează la scriere", async () => {
    expect(await service.isEnabled("blog")).toBe(false);
    expect(await redis.exists(FEATURE_FLAGS_CACHE_KEY)).toBe(1);

    await service.setEnabled("blog", true);
    expect(await redis.exists(FEATURE_FLAGS_CACHE_KEY)).toBe(0);
    expect(await service.isEnabled("blog")).toBe(true);

    const row = await db.featureFlag.findUniqueOrThrow({ where: { key: "blog" } });
    expect(row.enabled).toBe(true);
  });
});
