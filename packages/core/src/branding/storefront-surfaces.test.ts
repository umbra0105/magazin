import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { PRESETS } from "./presets";
import { PRESET_KEYS } from "./tokens";

/**
 * Suprafețele vitrinei care nu vin din preset, ci din `storefront-tokens.css` (aceleași în toate presets și teme): «masa foto» pe
 * care stau fotografiile produselor (carduri, plăci de meniu) și umplutura header-ului «sticlă». Fișierul se citește ca text.
 */
const css = readFileSync(
  new URL("../../../ui/src/styles/storefront-tokens.css", import.meta.url),
  "utf8",
);
const globals = readFileSync(
  new URL("../../../../apps/web/src/app/globals.css", import.meta.url),
  "utf8",
);

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match?.[1]) throw new Error(`tokenul ${name} lipsește din storefront-tokens.css`);
  return match[1].trim();
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, top share%, bottom)`. */
const mix = (top: string, share: number, bottom: string) => {
  const [a, b] = [rgb(top), rgb(bottom)];
  return toHex(a.map((v, i) => v * share + (b[i] ?? 0) * (1 - share)));
};

describe("masa foto: suprafața uniformă a imaginilor de produs", () => {
  it("există un singur token, o culoare fixă (nu depinde de preset sau de temă) și e expus ca utilitar", () => {
    const value = token("--sf-media-surface");
    expect(value).toMatch(/^oklch\(/);
    expect(value).not.toContain("var(");
    expect(globals).toContain("--color-media: var(--sf-media-surface)");
  });

  it("e deschisă: fotografiile cu fundal alb nu apar ca pătrate albe pe o suprafață colorată, nici în tema închisă", () => {
    const lightness = Number(/^oklch\(\s*([\d.]+)/.exec(token("--sf-media-surface"))?.[1]);
    // destul de deschisă ca albul fotografiei (după `multiply`) să devină culoarea mesei, dar nu atât încât în tema închisă să orbească
    expect(lightness).toBeGreaterThanOrEqual(0.9);
    expect(lightness).toBeLessThanOrEqual(0.97);
  });
});

describe("header «sticlă»: umplutura derivată din tokeni, text AA pe orice fotografie", () => {
  const opacity = Number.parseInt(token("--sf-glass-opacity"), 10) / 100;

  it("opacitatea e un procent din token, între 60% și 95% (translucid, dar nu transparent)", () => {
    expect(opacity).toBeGreaterThanOrEqual(0.6);
    expect(opacity).toBeLessThanOrEqual(0.95);
  });

  it.each(PRESET_KEYS)(
    "%s: textul principal trece AA chiar peste cea mai proastă fotografie (negru în tema deschisă, alb în cea închisă)",
    (key) => {
      for (const mode of ["light", "dark"] as const) {
        const { bg, fg } = PRESETS[key].colors[mode];
        const worstBackdrop = mode === "light" ? "#000000" : "#ffffff";
        const fill = mix(bg, opacity, worstBackdrop);
        expect(contrastRatio(fg, fill), `${key} ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("umplutura, estomparea și saturația sunt tokeni; fără backdrop-filter, umplutura devine opacă", () => {
    expect(css).toMatch(/--sf-glass-fill:\s*color-mix\(in srgb,\s*var\(--color-bg\)/);
    expect(token("--sf-glass-saturate")).toMatch(/^\d/);
    expect(token("--sf-glass-blur")).toMatch(/rem$/);
    expect(css).toMatch(/@supports not \(backdrop-filter/);
  });
});
