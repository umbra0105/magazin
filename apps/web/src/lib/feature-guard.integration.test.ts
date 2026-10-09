import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import {
  FEATURE_FLAGS_CACHE_KEY,
  FeatureFlagService,
  createPrismaFeatureFlagStore,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createFeatureGuard } from "./feature-guard";

// Garda cu serviciul REAL (Postgres + Redis de test): un flag stins dă 404 și nu încarcă codul
// funcției; pornit, îl încarcă; oprit din nou, se blochează imediat (invalidarea cache-ului).

class NotFound extends Error {}

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const flags = new FeatureFlagService(createPrismaFeatureFlagStore(db), redis);
const guard = createFeatureGuard({
  isEnabled: (key) => flags.isEnabled(key),
  notFound: () => {
    throw new NotFound("404");
  },
});

describe("garda de funcționalități (integrare)", () => {
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

  it("flag oprit implicit: 404 și loaderul nu se apelează", async () => {
    const loader = vi.fn(async () => "cod-blog");
    await expect(guard.loadFeature("blog", loader)).rejects.toBeInstanceOf(NotFound);
    expect(loader).not.toHaveBeenCalled();
  });

  it("pornit → încarcă; oprit din nou → 404 imediat", async () => {
    const loader = vi.fn(async () => "cod-blog");
    await flags.setEnabled("blog", true);
    await expect(guard.loadFeature("blog", loader)).resolves.toBe("cod-blog");
    expect(loader).toHaveBeenCalledTimes(1);

    await flags.setEnabled("blog", false);
    await expect(guard.loadFeature("blog", loader)).rejects.toBeInstanceOf(NotFound);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("un flag pornit nu deschide alt flag", async () => {
    await flags.setEnabled("blog", true);
    await expect(guard.requireFeature("vouchers")).rejects.toBeInstanceOf(NotFound);
    await expect(guard.requireFeature("blog")).resolves.toBeUndefined();
  });
});
