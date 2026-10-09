import type { Prisma, PrismaClient } from "@ecom/db";
import type { BrandingStore } from "./branding-service";

const ROW_ID = "default";

export function createPrismaBrandingStore(db: PrismaClient): BrandingStore {
  return {
    async load() {
      const row = await db.branding.findUnique({ where: { id: ROW_ID } });
      return row
        ? {
            preset: row.preset,
            colors: row.colors,
            fonts: row.fonts,
            radius: row.radius,
            darkMode: row.darkMode,
            logoUrl: row.logoUrl,
            faviconUrl: row.faviconUrl,
            ogImageUrl: row.ogImageUrl,
          }
        : null;
    },
    async save(row) {
      const data = {
        preset: row.preset,
        colors: row.colors as Prisma.InputJsonValue,
        fonts: row.fonts as Prisma.InputJsonValue,
        radius: row.radius,
        darkMode: row.darkMode,
        logoUrl: row.logoUrl,
        faviconUrl: row.faviconUrl,
        ogImageUrl: row.ogImageUrl,
      };
      await db.branding.upsert({
        where: { id: ROW_ID },
        create: { id: ROW_ID, ...data },
        update: data,
      });
    },
  };
}
