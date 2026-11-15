import { createHash } from "node:crypto";
import { PRESETS } from "./presets";
import {
  BUTTON_SHAPES,
  CARD_RADII,
  COLOR_CSS_VARS,
  COLOR_TOKENS,
  FONT_FAMILIES,
  HEADING_TRACKING,
  RADIUS_VALUES,
  type BrandingConfig,
  type ColorSet,
  type FontKey,
} from "./tokens";

const SANS_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const SERIF_FALLBACK = "ui-serif, Georgia, serif";

function fontStack(key: FontKey): string {
  const font = FONT_FAMILIES[key];
  return `var(${font.cssVar}), ${font.kind === "serif" ? SERIF_FALLBACK : SANS_FALLBACK}`;
}

function colorDeclarations(colors: ColorSet): string {
  return COLOR_TOKENS.map((token) => `${COLOR_CSS_VARS[token]}:${colors[token]}`).join(";");
}

/** Variabilele de formă ale vitrinei, din presetul ales: doar valori din tabele fixe (vezi `tokens.ts`). */
function shapeDeclarations(config: BrandingConfig): string {
  const shape = PRESETS[config.preset].shape;
  return [
    `--radius-button:${BUTTON_SHAPES[shape.button]}`,
    `--radius-card:${CARD_RADII[shape.card]}`,
    `--heading-weight:${shape.headingWeight}`,
    `--heading-tracking:${HEADING_TRACKING[shape.headingTracking]}`,
    `--hero-scrim:${shape.heroScrim}%`,
  ].join(";");
}

/**
 * CSS-ul temei. Primește DOAR un `BrandingConfig` deja validat de Zod și compune șirul numai din:
 * culori `#rrggbb` normalizate, nume de variabile din tabele fixe și valori de rază din enum.
 * Nu există nicio cale prin care text liber să ajungă în rezultat.
 *
 * `html:root` (specificitate mai mare decât `:root`) bate valorile implicite din globals.css
 * indiferent de ordinea în care se încarcă fișierele CSS.
 */
export function renderThemeCss(config: BrandingConfig): string {
  const base =
    `html:root{${colorDeclarations(config.colors.light)};` +
    `--radius:${RADIUS_VALUES[config.radius]};` +
    `--font-heading:${fontStack(config.fonts.heading)};` +
    `--font-body:${fontStack(config.fonts.body)};` +
    `${shapeDeclarations(config)}}`;
  if (!config.darkMode) return base;
  return `${base}\n@media (prefers-color-scheme:dark){html:root{${colorDeclarations(config.colors.dark)}}}`;
}

/**
 * Doar o paletă de culori (`html:root{...}`), pentru foile `/theme-light.css` și `/theme-dark.css`
 * din admin: schimbarea Luminos/Întunecat/Sistem se face comutând atributul `media` al linkurilor,
 * fără selectori suplimentari în CSS-ul principal. Aceeași garanție: doar valori validate.
 */
export function renderPaletteCss(colors: ColorSet): string {
  return `html:root{${colorDeclarations(colors)}}`;
}

/** ETag stabil: se schimbă doar când se schimbă CSS-ul. */
export function themeEtag(css: string): string {
  return `"${createHash("sha1").update(css).digest("base64url")}"`;
}

/** Selectorul previzualizării din galeria de dezvoltare a vitrinei: un singur element, fixat aici (nu vine din date). */
export const PREVIEW_SCOPE = "[data-theme-preview]";

/**
 * Tema unui preset aplicată doar pe elementul cu `data-theme-preview`, în tema deschisă sau închisă (indiferent de `darkMode`):
 * galeria de dezvoltare arată cele 3 presets una lângă alta, fără baza de date. Aceeași garanție: doar valori validate, un
 * singur bloc `{…}`.
 */
export function renderScopedThemeCss(config: BrandingConfig, mode: "light" | "dark"): string {
  return (
    `${PREVIEW_SCOPE}{${colorDeclarations(config.colors[mode])};` +
    `--radius:${RADIUS_VALUES[config.radius]};` +
    `--font-heading:${fontStack(config.fonts.heading)};` +
    `--font-body:${fontStack(config.fonts.body)};` +
    `${shapeDeclarations(config)};color-scheme:${mode}}`
  );
}
