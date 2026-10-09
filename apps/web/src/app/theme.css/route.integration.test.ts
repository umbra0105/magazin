import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { configFromPreset } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getBranding, getRedis } from "../../lib/services";
import { GET } from "./route";

// Ruta /theme.css cap-coadă, pe Postgres + Redis de test.

const db = getDb();
const request = (headers?: Record<string, string>) =>
  GET(new Request("http://localhost/theme.css", { headers }));

describe("GET /theme.css (integrare)", () => {
  beforeEach(async () => {
    await db.branding.deleteMany();
    await getBranding().invalidate();
  });

  afterAll(async () => {
    await db.branding.deleteMany();
    await getBranding().invalidate();
    getRedis().disconnect();
    await db.$disconnect();
  });

  it("fără Branding în DB servește tema Minimal, ca CSS, cu ETag și no-cache", async () => {
    const response = await request();
    const css = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^"[\w-]+"$/);
    expect(css).toContain("--color-bg:#ffffff");
    expect(css).toContain("html:root{");
  });

  it("If-None-Match cu ETag-ul curent dă 304 fără corp", async () => {
    const first = await request();
    const etag = first.headers.get("etag") ?? "";
    const second = await request({ "If-None-Match": etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("după salvarea unui alt preset, ETag-ul se schimbă și tema nouă e servită imediat", async () => {
    const before = await request();
    const oldEtag = before.headers.get("etag") ?? "";

    await getBranding().save(configFromPreset("editorial"));

    const after = await request({ "If-None-Match": oldEtag });
    const css = await after.text();
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(oldEtag);
    expect(css).toContain("--color-bg:#faf7f2");
    expect(css).toContain("var(--font-playfair-display)");
  });

  it("un rând invalid ajuns în DB nu strică site-ul: tema implicită, fără CSS injectat", async () => {
    await db.branding.create({
      data: {
        id: "default",
        preset: "bold",
        colors: { light: { bg: "#fff;} body{display:none} :root{--x:#000" } },
        fonts: { heading: "inter", body: "inter" },
        radius: "md",
      },
    });
    const response = await request();
    const css = await response.text();
    expect(response.status).toBe(200);
    expect(css).not.toContain("display:none");
    expect(css).toContain("--color-bg:#ffffff");
  });
});
