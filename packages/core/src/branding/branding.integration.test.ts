import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb } from "@ecom/db";
import { BRANDING_CACHE_KEY, BrandingService } from "./branding-service";
import { createPrismaBrandingStore } from "./prisma-store";
import { configFromPreset } from "./presets";

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const db = getDb();
const service = new BrandingService(createPrismaBrandingStore(db), redis);

describe("BrandingService (Postgres + Redis reale)", () => {
  beforeEach(async () => {
    await db.branding.deleteMany();
    await redis.del(BRANDING_CACHE_KEY);
  });

  afterAll(async () => {
    await db.branding.deleteMany();
    await redis.del(BRANDING_CACHE_KEY);
    redis.disconnect();
    await db.$disconnect();
  });

  it("fără rând: tema Minimal; după save: tema salvată, cache invalidat", async () => {
    expect((await service.getTheme()).css).toContain("--color-primary:#1f1f1f");
    expect(await redis.exists(BRANDING_CACHE_KEY)).toBe(1);

    const config = { ...configFromPreset("bold"), darkMode: true };
    const { warnings } = await service.save(config);
    expect(warnings).toEqual([]);
    expect(await redis.exists(BRANDING_CACHE_KEY)).toBe(0);

    const { css, etag } = await service.getTheme();
    expect(css).toContain("--color-primary:#c2410c");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(etag).toMatch(/^"[\w-]+"$/);

    const row = await db.branding.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.preset).toBe("bold");
    expect(row.darkMode).toBe(true);
  });

  it("CSS injectat direct în DB nu ajunge în theme.css", async () => {
    await db.branding.create({
      data: {
        id: "default",
        preset: "bold",
        colors: { light: { bg: "#fff;} body{display:none} :root{--x:#000" } },
        fonts: { heading: "inter", body: "inter" },
        radius: "md",
      },
    });
    const { css } = await service.getTheme();
    expect(css).not.toContain("display:none");
    expect(css).toContain("--color-bg:#ffffff");
  });
});
