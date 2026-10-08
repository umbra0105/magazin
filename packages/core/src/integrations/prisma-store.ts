import type { Prisma, PrismaClient } from "@ecom/db";
import type { IntegrationStore } from "./integration-service";

export function createPrismaIntegrationStore(db: PrismaClient): IntegrationStore {
  return {
    async find(type, provider) {
      const row = await db.integration.findUnique({
        where: { type_provider: { type, provider } },
      });
      return row
        ? {
            type: row.type,
            provider: row.provider,
            credentials: row.credentials,
            config: row.config,
            isActive: row.isActive,
          }
        : null;
    },
    async upsert({ type, provider, credentials, config, isActive }) {
      const json = config as Prisma.InputJsonValue;
      await db.integration.upsert({
        where: { type_provider: { type, provider } },
        create: { type, provider, credentials, config: json, isActive },
        update: { credentials, config: json, isActive },
      });
    },
  };
}
