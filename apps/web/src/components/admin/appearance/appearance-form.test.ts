import { describe, expect, it } from "vitest";
import {
  applyPreset,
  isDirty,
  isHexColor,
  normalizeErrors,
  toSavePayload,
  type AppearanceForm,
  type BrandingForm,
} from "./appearance-form";

const colors = (bg: string) => ({
  bg,
  fg: "#111111",
  muted: "#555555",
  border: "#dddddd",
  primary: "#0b5cad",
  primaryFg: "#ffffff",
  accent: "#0e7490",
  success: "#15803d",
  danger: "#b91c1c",
});

const branding = (over: Partial<BrandingForm> = {}): BrandingForm => ({
  preset: "minimal",
  colors: { light: colors("#ffffff"), dark: colors("#0d1217") },
  fonts: { heading: "manrope", body: "manrope" },
  radius: "lg",
  darkMode: false,
  logoUrl: "",
  faviconUrl: "",
  ogImageUrl: "",
  customCss: "",
  ...over,
});

const form = (over: Partial<AppearanceForm> = {}): AppearanceForm => ({
  branding: branding(),
  settings: {
    headerVariant: "default",
    footerVariant: "default",
    containerWidth: "xl",
    cardLayout: "vertical",
    announcementEnabled: false,
    announcementText: "",
    announcementHref: "",
    announcementTone: "brand",
  },
  ...over,
});

describe("isHexColor", () => {
  it("#rgb și #rrggbb, cu spații la capete tolerate; nimic altceva", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#0B5CAD")).toBe(true);
    expect(isHexColor(" #0b5cad ")).toBe(true);
    for (const bad of ["", "fff", "#ffff", "#ggg", "red", "rgb(0,0,0)", "#12345"]) {
      expect(isHexColor(bad), bad).toBe(false);
    }
  });
});

describe("toSavePayload", () => {
  it("adresele goale devin null; culorile și textele își pierd spațiile de la capete", () => {
    const f = form();
    f.branding.logoUrl = "  ";
    f.branding.faviconUrl = " /media/f.png ";
    f.branding.colors.light.bg = " #fff ";
    f.settings.announcementText = "  Salut  ";
    const payload = toSavePayload(f);
    expect(payload.branding.logoUrl).toBeNull();
    expect(payload.branding.faviconUrl).toBe("/media/f.png");
    expect(payload.branding.colors.light.bg).toBe("#fff");
    expect(payload.settings.announcementText).toBe("Salut");
  });
});

describe("isDirty", () => {
  it("formular identic sau doar cu spații în plus: nemodificat", () => {
    const saved = form();
    const current = form();
    current.branding.logoUrl = "   ";
    expect(isDirty(current, saved)).toBe(false);
  });

  it("orice schimbare reală (culoare, variantă, anunț, CSS) îl face modificat", () => {
    const saved = form();
    const a = form();
    a.branding.colors.dark.accent = "#000000";
    const b = form();
    b.settings.headerVariant = "glass";
    const c = form();
    c.branding.customCss = ".x{a:b}";
    for (const changed of [a, b, c]) expect(isDirty(changed, saved)).toBe(true);
  });
});

describe("applyPreset", () => {
  it("înlocuiește culorile, fonturile și raza, dar păstrează logo-ul, modul închis și CSS-ul personalizat", () => {
    const current = branding({
      logoUrl: "/media/logo.png",
      darkMode: true,
      customCss: ".x{a:b}",
      colors: { light: colors("#eeeeee"), dark: colors("#111111") },
    });
    const preset = branding({
      preset: "bold",
      colors: { light: colors("#f4f7fb"), dark: colors("#0b1220") },
      fonts: { heading: "montserrat", body: "openSans" },
      radius: "sm",
    });
    const result = applyPreset(current, preset);
    expect(result.preset).toBe("bold");
    expect(result.colors.light.bg).toBe("#f4f7fb");
    expect(result.fonts).toEqual({ heading: "montserrat", body: "openSans" });
    expect(result.radius).toBe("sm");
    expect(result.logoUrl).toBe("/media/logo.png");
    expect(result.darkMode).toBe(true);
    expect(result.customCss).toBe(".x{a:b}");
    // copie, nu referință: modificările ulterioare nu ating presetul
    result.colors.light.bg = "#000000";
    expect(preset.colors.light.bg).toBe("#f4f7fb");
  });
});

describe("normalizeErrors", () => {
  it("scoate prefixul branding., lasă settings. neatins", () => {
    expect(
      normalizeErrors({
        "branding.colors.light.bg": "x",
        "settings.announcementText": "y",
        customCss: "z",
      }),
    ).toEqual({ "colors.light.bg": "x", "settings.announcementText": "y", customCss: "z" });
  });
});
