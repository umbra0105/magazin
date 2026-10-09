import { createHash } from "node:crypto";
import {
  COLOR_CSS_VARS,
  COLOR_TOKENS,
  FONT_FAMILIES,
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
    `--font-body:${fontStack(config.fonts.body)}}`;
  if (!config.darkMode) return base;
  return `${base}\n@media (prefers-color-scheme:dark){html:root{${colorDeclarations(config.colors.dark)}}}`;
}

/** ETag stabil: se schimbă doar când se schimbă CSS-ul. */
export function themeEtag(css: string): string {
  return `"${createHash("sha1").update(css).digest("base64url")}"`;
}
