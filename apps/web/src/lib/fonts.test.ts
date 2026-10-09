import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_FAMILIES } from "@ecom/core";

describe("fonturi locale (next/font)", () => {
  const source = readFileSync(new URL("./fonts.ts", import.meta.url), "utf8");

  it("fiecare font permis în temă are variabila lui declarată în fonts.ts", () => {
    for (const [key, font] of Object.entries(FONT_FAMILIES)) {
      expect(source, key).toContain(`variable: "${font.cssVar}"`);
    }
  });

  it("nu folosește încărcare externă (fără <link>/@import/URL de CDN)", () => {
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/@import|<link/);
    expect(source).toContain("next/font/google");
  });

  it("include latin-ext pentru diacriticele românești", () => {
    expect(source).toContain("latin-ext");
  });
});
