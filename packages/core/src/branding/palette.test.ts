import { describe, expect, it } from "vitest";
import { PRESETS, configFromPreset } from "./presets";
import { PRESET_KEYS } from "./tokens";
import { renderPaletteCss } from "./css";

describe("renderPaletteCss (foile /theme-light.css și /theme-dark.css din admin)", () => {
  it("un singur bloc html:root cu cele 9 culori ale paletei, exact", () => {
    const css = renderPaletteCss(PRESETS.minimal.colors.dark);
    expect(css.startsWith("html:root{--color-bg:")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
    expect(css.match(/--color-/g)).toHaveLength(9);
    expect(css).toContain(PRESETS.minimal.colors.dark.bg);
    expect(css).not.toContain(PRESETS.minimal.colors.light.bg + ";--color-fg");
  });

  it("doar caractere dintr-o listă permisă, pentru toate presetele și ambele palete", () => {
    const allowed = /^[A-Za-z0-9#:;,.()@{}\s-]+$/;
    for (const key of PRESET_KEYS) {
      for (const mode of ["light", "dark"] as const) {
        const css = renderPaletteCss(configFromPreset(key).colors[mode]);
        expect(css, `${key} ${mode}`).toMatch(allowed);
        for (const forbidden of ["url(", "@import", "<", ">", "\\", '"', "'", "/*"]) {
          expect(css).not.toContain(forbidden);
        }
      }
    }
  });
});
