import type { PrismaClient } from "@ecom/db";
import type { FeatureFlagStore } from "./feature-flag-service";

export function createPrismaFeatureFlagStore(db: PrismaClient): FeatureFlagStore {
  return {
    async loadAll() {
      return db.featureFlag.findMany({ select: { key: true, enabled: true } });
    },
    async upsert({ key, enabled, description }) {
      await db.featureFlag.upsert({
        where: { key },
        create: { key, enabled, description },
        update: { enabled, description },
      });
    },
  };
}
