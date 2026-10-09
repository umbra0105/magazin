import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@ecom/shared";
import type { KeyValueCache } from "../cache/read-through";
import {
  BrandingService,
  BRANDING_CACHE_KEY,
  type BrandingRow,
  type BrandingStore,
} from "./branding-service";
import { checkContrast, contrastRatio } from "./contrast";
import { renderThemeCss, themeEtag } from "./css";
import { PRESETS, configFromPreset } from "./presets";
import { FONT_FAMILIES, PRESET_KEYS, brandingConfigSchema } from "./tokens";

function fakes() {
  let row: BrandingRow | null = null;
  const cacheData = new Map<string, string>();
  const calls = { load: 0 };
  const store: BrandingStore = {
    async load() {
      calls.load++;
      return row;
    },
    async save(next) {
      row = next;
    },
  };
  const cache: KeyValueCache = {
    async get(key) {
      return cacheData.get(key) ?? null;
    },
    async set(key, value) {
      cacheData.set(key, value);
      return "OK";
    },
    async del(key) {
      return cacheData.delete(key) ? 1 : 0;
    },
  };
  return { store, cache, cacheData, calls, setRow: (r: BrandingRow | null) => (row = r) };
}

describe("contrast WCAG", () => {
  it("calculează raporturile cunoscute", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("toate cele 3 presets trec AA, în varianta light și dark", () => {
    for (const key of PRESET_KEYS) {
      const config = { ...configFromPreset(key), darkMode: true };
      expect(checkContrast(config), key).toEqual([]);
    }
  });

  it("prinde perechile slabe și verifică dark doar când darkMode e pornit", () => {
    const config = configFromPreset("minimal");
    config.colors.light.muted = "#cccccc";
    config.colors.dark.fg = "#222222";
    const light = checkContrast(config);
    expect(light.map((w) => `${w.mode}:${w.foreground}/${w.background}`)).toEqual([
      "light:muted/bg",
    ]);
    expect(light[0]?.ratio).toBeLessThan(4.5);
    const both = checkContrast({ ...config, darkMode: true });
    expect(both.some((w) => w.mode === "dark" && w.foreground === "fg")).toBe(true);
  });
});

describe("validare strictă (fără injecție de CSS)", () => {
  const valid = () => configFromPreset("bold");

  it("acceptă un preset valid și normalizează culorile", () => {
    const input = valid();
    input.colors.light.bg = "#FFF";
    const parsed = brandingConfigSchema.parse(input);
    expect(parsed.colors.light.bg).toBe("#ffffff");
  });

  it.each([
    "red",
    "rgb(0,0,0)",
    "oklch(0.5 0 0)",
    "#12345",
    "#ggg",
    "#fff;}body{display:none}",
    "#fff} * {background:url(https://evil.test/x)} :root{--x:#fff",
    "url(https://evil.test)",
    "var(--x)",
    "",
  ])("respinge culoarea %j", (bad) => {
    const input = valid();
    input.colors.light.fg = bad;
    expect(brandingConfigSchema.safeParse(input).success).toBe(false);
  });

  it("respinge fonturi din afara listei permise și rază liberă", () => {
    const font = { ...valid(), fonts: { heading: "Comic Sans; } body{x:y", body: "inter" } };
    expect(brandingConfigSchema.safeParse(font).success).toBe(false);
    const radius = { ...valid(), radius: "9999px; } *{display:none" };
    expect(brandingConfigSchema.safeParse(radius).success).toBe(false);
  });

  it("respinge chei necunoscute (nu intră câmpuri libere)", () => {
    expect(brandingConfigSchema.safeParse({ ...valid(), customCss: "body{}" }).success).toBe(false);
    const input = valid();
    (input.colors.light as Record<string, string>)["extra"] = "#ffffff";
    expect(brandingConfigSchema.safeParse(input).success).toBe(false);
  });

  it("URL-uri de imagini: doar https sau cale locală", () => {
    for (const ok of ["https://cdn.exemplu.ro/logo.png", "/media/logo.svg", null]) {
      expect(brandingConfigSchema.safeParse({ ...valid(), logoUrl: ok }).success, String(ok)).toBe(
        true,
      );
    }
    for (const bad of [
      "javascript:alert(1)",
      "//evil.test/x.png",
      "http://x.ro/a.png",
      'https://x.ro/a"onload=1',
      "data:image/png;base64,AA",
    ]) {
      expect(brandingConfigSchema.safeParse({ ...valid(), logoUrl: bad }).success, bad).toBe(false);
    }
  });
});

describe("renderThemeCss", () => {
  it("produce variabile pentru toate token-urile și nimic altceva decât valori validate", () => {
    const css = renderThemeCss(configFromPreset("minimal"));
    for (const name of [
      "--color-bg",
      "--color-fg",
      "--color-primary-fg",
      "--radius",
      "--font-heading",
      "--font-body",
    ]) {
      expect(css).toContain(name);
    }
    expect(css).toContain("--color-bg:#ffffff");
    expect(css).toContain("--radius:0.5rem");
    expect(css).toContain("var(--font-inter)");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("adaugă paleta dark doar când darkMode e pornit", () => {
    const config = { ...configFromPreset("editorial"), darkMode: true };
    const css = renderThemeCss(config);
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    expect(css).toContain(PRESETS.editorial.colors.dark.bg);
    expect(css).toContain("ui-serif");
  });

  it("toate fonturile permise au variabilă CSS proprie", () => {
    const vars = Object.values(FONT_FAMILIES).map((f) => f.cssVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it("ETag stabil pentru același CSS, diferit când se schimbă", () => {
    const a = renderThemeCss(configFromPreset("minimal"));
    expect(themeEtag(a)).toBe(themeEtag(a));
    expect(themeEtag(a)).not.toBe(themeEtag(renderThemeCss(configFromPreset("bold"))));
  });
});

describe("BrandingService", () => {
  let f: ReturnType<typeof fakes>;
  let service: BrandingService;

  beforeEach(() => {
    f = fakes();
    service = new BrandingService(f.store, f.cache);
  });

  it("fără rând în DB folosește presetul Minimal", async () => {
    expect((await service.getConfig()).preset).toBe("minimal");
    expect((await service.getTheme()).css).toContain("--color-bg:#ffffff");
  });

  it("save validează, scrie, invalidează cache-ul și întoarce avertismentele", async () => {
    await service.getConfig();
    expect(f.cacheData.has(BRANDING_CACHE_KEY)).toBe(true);
    const input = configFromPreset("bold");
    input.colors.light.muted = "#dddddd";
    const result = await service.save(input);
    expect(f.cacheData.has(BRANDING_CACHE_KEY)).toBe(false);
    expect(result.warnings.map((w) => w.foreground)).toEqual(["muted"]);
    expect((await service.getConfig()).preset).toBe("bold");
    expect((await service.getTheme()).css).toContain("--color-muted:#dddddd");
  });

  it("save respinge input invalid fără să scrie", async () => {
    const input = configFromPreset("bold");
    input.colors.light.bg = "red";
    await expect(service.save(input)).rejects.toBeInstanceOf(ValidationError);
    expect(await f.store.load()).toBeNull();
  });

  it("date invalide ajunse în DB nu strică site-ul: revine la presetul implicit", async () => {
    f.setRow({
      preset: "bold",
      colors: { light: { bg: "} body{display:none" } },
      fonts: {},
      radius: "x",
      darkMode: false,
      logoUrl: null,
      faviconUrl: null,
      ogImageUrl: null,
    });
    const { css } = await service.getTheme();
    expect(css).not.toContain("display:none");
    expect(css).toContain("--color-bg:#ffffff");
  });

  it("citește din cache (o singură interogare în DB)", async () => {
    await service.getConfig();
    await service.getTheme();
    expect(f.calls.load).toBe(1);
  });

  it("cade pe DB când Redis e picat", async () => {
    const broken: KeyValueCache = {
      get: () => Promise.reject(new Error("redis picat")),
      set: () => Promise.reject(new Error("redis picat")),
      del: () => Promise.reject(new Error("redis picat")),
    };
    const s = new BrandingService(f.store, broken);
    await s.save(configFromPreset("editorial"));
    expect((await s.getConfig()).preset).toBe("editorial");
  });
});
