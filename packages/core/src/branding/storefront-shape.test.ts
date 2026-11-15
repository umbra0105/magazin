import { describe, expect, it } from "vitest";
import { checkContrast, contrastRatio } from "./contrast";
import { renderScopedThemeCss, renderThemeCss, PREVIEW_SCOPE } from "./css";
import { DEFAULT_PRESET, PRESETS, configFromPreset } from "./presets";
import { BUTTON_SHAPES, CARD_RADII, HEADING_TRACKING, PRESET_KEYS } from "./tokens";

/** Cât din fundalul unui card (35% din culoarea de bordură peste pagină) se amestecă, ca la tokenul `--surface-subtle`. */
function tinted(bg: string, border: string): string {
  const mix = (shift: number) =>
    Math.round(
      ((Number.parseInt(bg.slice(1), 16) >> shift) & 255) * 0.65 +
        ((Number.parseInt(border.slice(1), 16) >> shift) & 255) * 0.35,
    );
  return `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, "0")).join("")}`;
}

describe("presetul implicit («echilibrat»)", () => {
  it("e Minimal, cu butoane pastilă și carduri mari", () => {
    expect(DEFAULT_PRESET).toBe("minimal");
    expect(PRESETS.minimal.shape.button).toBe("pill");
    expect(CARD_RADII[PRESETS.minimal.shape.card]).toBe("1.5rem");
  });

  it("Minimal folosește o singură familie de font (Manrope), pe greutăți", () => {
    expect(PRESETS.minimal.fonts).toEqual({ heading: "manrope", body: "manrope" });
  });
});

describe("cele 3 presets se deosebesc prin formă, nu doar prin culoare", () => {
  it("forma (buton, rază de card, greutate, strat pe imagine) diferă în fiecare pereche", () => {
    const shapes = PRESET_KEYS.map((key) => JSON.stringify(PRESETS[key].shape));
    expect(new Set(shapes).size).toBe(PRESET_KEYS.length);
    expect(PRESETS.bold.shape.button).toBe("round");
    expect(PRESETS.editorial.shape.button).toBe("square");
    expect(PRESETS.editorial.shape.headingWeight).toBeLessThan(PRESETS.bold.shape.headingWeight);
  });

  it("Editorial nu mai e «hârtie cremă + teracotă»: fundalul e rece (albastrul peste roșu), accentul nu e portocaliu", () => {
    const { bg, accent } = PRESETS.editorial.colors.light;
    const n = Number.parseInt(bg.slice(1), 16);
    expect(n & 255).toBeGreaterThanOrEqual((n >> 16) & 255);
    const a = Number.parseInt(accent.slice(1), 16);
    // brass: roșu și verde apropiate, albastrul mult mai mic (nu teracotă: roșu >> verde)
    expect(((a >> 16) & 255) - ((a >> 8) & 255)).toBeLessThan(60);
  });
});

describe("contrast pe suprafața cardurilor (fundal înclinat) și pe stratul de imagine", () => {
  it.each(PRESET_KEYS)("%s: text secundar și accent trec AA și pe card, în ambele teme", (key) => {
    for (const mode of ["light", "dark"] as const) {
      const c = PRESETS[key].colors[mode];
      const card = tinted(c.bg, c.border);
      expect(contrastRatio(c.muted, card), `${key} ${mode} muted/card`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.fg, card), `${key} ${mode} fg/card`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.accent, card), `${key} ${mode} accent/card`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    expect(checkContrast({ ...configFromPreset(key), darkMode: true })).toEqual([]);
  });
});

describe("renderThemeCss: variabilele de formă", () => {
  it.each(PRESET_KEYS)(
    "%s: emite razele, greutatea, strângerea și stratul din tabele fixe",
    (key) => {
      const css = renderThemeCss(configFromPreset(key));
      const shape = PRESETS[key].shape;
      expect(css).toContain(`--radius-button:${BUTTON_SHAPES[shape.button]}`);
      expect(css).toContain(`--radius-card:${CARD_RADII[shape.card]}`);
      expect(css).toContain(`--heading-weight:${shape.headingWeight}`);
      expect(css).toContain(`--heading-tracking:${HEADING_TRACKING[shape.headingTracking]}`);
      expect(css).toContain(`--hero-scrim:${shape.heroScrim}%`);
    },
  );

  it("minimal: butonul e pastilă; editorial: aproape dreptunghiular", () => {
    expect(renderThemeCss(configFromPreset("minimal"))).toContain("--radius-button:9999px");
    expect(renderThemeCss(configFromPreset("editorial"))).toContain("--radius-button:0.125rem");
  });

  it("forma urmează presetul ales, nu cel implicit (schimbarea presetului schimbă CSS-ul)", () => {
    expect(renderThemeCss(configFromPreset("bold"))).not.toBe(
      renderThemeCss(configFromPreset("minimal")),
    );
    expect(renderThemeCss(configFromPreset("bold"))).toContain("--heading-weight:800");
  });
});

describe("renderScopedThemeCss (previzualizarea din galeria de dezvoltare)", () => {
  it("scoate culorile, fonturile și forma într-un selector fix, fără `html:root`", () => {
    const css = renderScopedThemeCss(configFromPreset("bold"), "light");
    expect(css.startsWith(`${PREVIEW_SCOPE}{`)).toBe(true);
    expect(css).not.toContain("html:root");
    expect(css).toContain(`--color-bg:${PRESETS.bold.colors.light.bg}`);
    expect(css).toContain("--radius-button:var(--radius)");
    expect(css).toContain("color-scheme:light");
  });

  it("varianta dark ia paleta întunecată, indiferent de `darkMode` din configurație", () => {
    const css = renderScopedThemeCss(configFromPreset("minimal"), "dark");
    expect(css).toContain(`--color-bg:${PRESETS.minimal.colors.dark.bg}`);
    expect(css).toContain("color-scheme:dark");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("nu interpolează nimic din afara valorilor validate (nicio acoladă sau punct și virgulă în plus)", () => {
    const css = renderScopedThemeCss(configFromPreset("editorial"), "light");
    expect(css.match(/\{/g)?.length).toBe(1);
    expect(css.match(/\}/g)?.length).toBe(1);
  });
});
