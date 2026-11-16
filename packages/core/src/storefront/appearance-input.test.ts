import { describe, expect, it } from "vitest";
import { configFromPreset } from "../branding/presets";
import { appearanceInputSchema, issuesByField } from "./appearance-input";

const valid = () => ({
  branding: configFromPreset("minimal"),
  settings: {
    headerVariant: "glass",
    footerVariant: "compact",
    containerWidth: "2xl",
    cardLayout: "horizontal",
    announcementEnabled: true,
    announcementText: "Livrare gratuită",
    announcementHref: "/livrare-si-plata",
    announcementTone: "neutral",
  },
});

describe("appearanceInputSchema (ce primește acțiunea de salvare din editorul de temă)", () => {
  it("acceptă un formular complet și normalizează culorile", () => {
    const input = valid();
    input.branding.colors.light.bg = "#FFF";
    const parsed = appearanceInputSchema.parse(input);
    expect(parsed.branding.colors.light.bg).toBe("#ffffff");
    expect(parsed.settings.headerVariant).toBe("glass");
  });

  it("respinge chei necunoscute la ambele niveluri (nu se pot strecura alte setări)", () => {
    const extra = { ...valid(), settings: { ...valid().settings, "auth.adminSessionHours": 99 } };
    expect(appearanceInputSchema.safeParse(extra).success).toBe(false);
    expect(appearanceInputSchema.safeParse({ ...valid(), altceva: 1 }).success).toBe(false);
  });

  it("respinge valorile din afara listelor și destinații periculoase ale anunțului", () => {
    const bad = (patch: Record<string, unknown>) =>
      appearanceInputSchema.safeParse({ ...valid(), settings: { ...valid().settings, ...patch } })
        .success;
    expect(bad({ headerVariant: "neon" })).toBe(false);
    expect(bad({ containerWidth: "gigant" })).toBe(false);
    expect(bad({ announcementHref: "javascript:alert(1)" })).toBe(false);
    expect(bad({ announcementText: "a".repeat(201) })).toBe(false);
    expect(bad({ announcementTone: "brand" })).toBe(true);
  });

  it("CSS personalizat periculos e respins cu eroare pe câmpul customCss", () => {
    const input = valid();
    input.branding.customCss = ".x{background:url(https://evil.test/a.png)}";
    const parsed = appearanceInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byField = issuesByField(parsed.error);
      expect(Object.keys(byField)).toEqual(["branding.customCss"]);
      expect(byField["branding.customCss"]).toBeTruthy();
    }
  });
});

describe("issuesByField", () => {
  it("o singură eroare pe câmp (prima), cu calea separată prin punct", () => {
    const input = valid();
    input.branding.colors.dark.primary = "rosu";
    input.settings.announcementText = "a".repeat(300);
    const parsed = appearanceInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byField = issuesByField(parsed.error);
      expect(Object.keys(byField).sort()).toEqual([
        "branding.colors.dark.primary",
        "settings.announcementText",
      ]);
    }
  });
});
