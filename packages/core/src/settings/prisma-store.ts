import type { Prisma, PrismaClient } from "@ecom/db";
import type { SettingsStore } from "./settings-service";

export function createPrismaSettingsStore(db: PrismaClient): SettingsStore {
  return {
    async loadAll() {
      const rows = await db.setting.findMany({ select: { key: true, value: true } });
      return rows.map((r) => ({ key: r.key, value: r.value }));
    },
    async upsert({ key, group, value }) {
      const json = value as Prisma.InputJsonValue;
      await db.setting.upsert({
        where: { key },
        create: { key, group, value: json },
        update: { group, value: json },
      });
    },
  };
}
