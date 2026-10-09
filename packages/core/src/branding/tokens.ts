import { z } from "zod";

/**
 * Tokens de temă. Tot ce ajunge în CSS trece prin aceste scheme STRICTE: culori doar hex,
 * fonturi doar din lista permisă, rază din enum, fără chei necunoscute. Generatorul de CSS
 * (`css.ts`) nu interpolează niciodată text liber, deci din admin nu se poate injecta CSS.
 */

export const COLOR_TOKENS = [
  "bg",
  "fg",
  "muted",
  "border",
  "primary",
  "primaryFg",
  "accent",
  "success",
  "danger",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Nume variabile CSS (existente în globals.css). */
export const COLOR_CSS_VARS: Record<ColorToken, string> = {
  bg: "--color-bg",
  fg: "--color-fg",
  muted: "--color-muted",
  border: "--color-border",
  primary: "--color-primary",
  primaryFg: "--color-primary-fg",
  accent: "--color-accent",
  success: "--color-success",
  danger: "--color-danger",
};

/** `#rgb` sau `#rrggbb`, normalizat la `#rrggbb` minuscule. Niciun alt format de culoare. */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "culoare invalidă: folosește #rgb sau #rrggbb")
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
  });

const colorSet = z.strictObject({
  bg: hexColor,
  fg: hexColor,
  muted: hexColor,
  border: hexColor,
  primary: hexColor,
  primaryFg: hexColor,
  accent: hexColor,
  success: hexColor,
  danger: hexColor,
});
export type ColorSet = z.output<typeof colorSet>;

/** Fonturile permise. `cssVar` = variabila declarată în `apps/web/src/lib/fonts.ts` cu next/font. */
export const FONT_FAMILIES = {
  inter: { label: "Inter", cssVar: "--font-inter", kind: "sans" },
  manrope: { label: "Manrope", cssVar: "--font-manrope", kind: "sans" },
  montserrat: { label: "Montserrat", cssVar: "--font-montserrat", kind: "sans" },
  openSans: { label: "Open Sans", cssVar: "--font-open-sans", kind: "sans" },
  lora: { label: "Lora", cssVar: "--font-lora", kind: "serif" },
  playfairDisplay: { label: "Playfair Display", cssVar: "--font-playfair-display", kind: "serif" },
} as const;
export type FontKey = keyof typeof FONT_FAMILIES;
export const FONT_KEYS = Object.keys(FONT_FAMILIES) as [FontKey, ...FontKey[]];

export const RADIUS_VALUES = {
  none: "0",
  sm: "0.25rem",
  md: "0.5rem",
  lg: "0.75rem",
  xl: "1rem",
} as const;
export type RadiusKey = keyof typeof RADIUS_VALUES;
export const RADIUS_KEYS = Object.keys(RADIUS_VALUES) as [RadiusKey, ...RadiusKey[]];

export const PRESET_KEYS = ["minimal", "bold", "editorial"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** URL de imagine: https absolut sau cale locală, fără caractere care ar putea ieși dintr-un atribut/URL. */
const assetUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => /^https:\/\/[^\s"'<>()\\]+$/.test(value) || /^\/(?!\/)[^\s"'<>()\\]*$/.test(value),
    "URL invalid: folosește https://... sau o cale locală care începe cu /",
  );

export const brandingConfigSchema = z.strictObject({
  preset: z.enum(PRESET_KEYS),
  colors: z.strictObject({ light: colorSet, dark: colorSet }),
  fonts: z.strictObject({ heading: z.enum(FONT_KEYS), body: z.enum(FONT_KEYS) }),
  radius: z.enum(RADIUS_KEYS),
  /** Dacă e pornit, paleta `dark` se aplică automat când vizitatorul are tema întunecată în sistem. */
  darkMode: z.boolean(),
  logoUrl: assetUrl.nullable(),
  faviconUrl: assetUrl.nullable(),
  ogImageUrl: assetUrl.nullable(),
});
export type BrandingConfig = z.output<typeof brandingConfigSchema>;
