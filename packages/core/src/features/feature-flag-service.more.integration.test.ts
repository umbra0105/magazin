import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
import { FEATURE_FLAGS_CACHE_KEY, FeatureFlagService } from "./feature-flag-service";
import { createPrismaFeatureFlagStore } from "./prisma-store";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const store = createPrismaFeatureFlagStore(db);

describe("FeatureFlagService: Redis picat (Redis real inaccesibil)", () => {
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

  it("citește și scrie prin DB când Redis nu răspunde, fără erori către apelant", async () => {
    // Port închis: conexiunea eșuează imediat, fără reîncercări.
    const dead = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    dead.on("error", () => undefined);
    try {
      const service = new FeatureFlagService(store, dead);
      expect(await service.isEnabled("blog")).toBe(false);
      await service.setEnabled("blog", true);
      expect(await service.isEnabled("blog")).toBe(true);
      expect((await db.featureFlag.findUniqueOrThrow({ where: { key: "blog" } })).enabled).toBe(
        true,
      );
    } finally {
      dead.disconnect();
    }
  });

  it("două instanțe (două procese) pe același Redis rămân coerente după setEnabled", async () => {
    const a = new FeatureFlagService(store, redis);
    const b = new FeatureFlagService(store, redis);
    expect(await b.isEnabled("reviews")).toBe(false);
    await a.setEnabled("reviews", true);
    expect(await b.isEnabled("reviews")).toBe(true);
    await a.setEnabled("reviews", false);
    expect(await b.isEnabled("reviews")).toBe(false);
  });
});
