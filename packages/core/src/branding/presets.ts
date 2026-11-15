import type { BrandingConfig, ColorSet, PresetKey, PresetShape } from "./tokens";

interface Preset {
  label: string;
  colors: { light: ColorSet; dark: ColorSet };
  fonts: BrandingConfig["fonts"];
  radius: BrandingConfig["radius"];
  /** Forma vitrinei (butoane, carduri, titluri, strat pe fotografie): tokeni derivați, vezi `tokens.ts`. */
  shape: PresetShape;
}

/**
 * Cele 3 presets (planul de design: `docs/21-referinte-vitrina.md` §2). Toate trec verificarea de contrast AA, inclusiv pe
 * suprafața cardurilor (testată în `branding.test.ts` și `storefront-shape.test.ts`). **Minimal** e presetul implicit și
 * poartă direcția «echilibrat»: pagină luminoasă, carduri mari, butoane pastilă, o singură familie de font pe greutăți.
 */
export const PRESETS: Record<PresetKey, Preset> = {
  minimal: {
    label: "Minimal",
    colors: {
      light: {
        bg: "#ffffff",
        fg: "#12171c",
        muted: "#55606b",
        border: "#dfe5ea",
        primary: "#0b5cad",
        primaryFg: "#ffffff",
        accent: "#0e7490",
        success: "#15803d",
        danger: "#b91c1c",
      },
      dark: {
        bg: "#0d1217",
        fg: "#f1f5f8",
        muted: "#9aa6b1",
        border: "#25303a",
        primary: "#5aa9f2",
        primaryFg: "#08121c",
        accent: "#4fd1e0",
        success: "#4ade80",
        danger: "#f87171",
      },
    },
    fonts: { heading: "manrope", body: "manrope" },
    radius: "lg",
    shape: {
      button: "pill",
      card: "xl",
      headingWeight: 700,
      headingTracking: "tight",
      heroScrim: 55,
    },
  },
  bold: {
    label: "Bold",
    colors: {
      light: {
        bg: "#f4f7fb",
        fg: "#111827",
        muted: "#4b5563",
        border: "#cdd6e2",
        primary: "#c2410c",
        primaryFg: "#ffffff",
        accent: "#0f766e",
        success: "#15803d",
        danger: "#b91c1c",
      },
      dark: {
        bg: "#0b1220",
        fg: "#f9fafb",
        muted: "#9ca3af",
        border: "#1f2937",
        primary: "#fb923c",
        primaryFg: "#1c1917",
        accent: "#2dd4bf",
        success: "#4ade80",
        danger: "#f87171",
      },
    },
    fonts: { heading: "montserrat", body: "openSans" },
    radius: "lg",
    shape: {
      button: "round",
      card: "lg",
      headingWeight: 800,
      headingTracking: "tighter",
      heroScrim: 65,
    },
  },
  editorial: {
    label: "Editorial",
    colors: {
      light: {
        bg: "#f6f7f9",
        fg: "#151a26",
        muted: "#525a6b",
        border: "#dde1e8",
        primary: "#1b2a49",
        primaryFg: "#ffffff",
        accent: "#8a5d0b",
        success: "#166534",
        danger: "#991b1b",
      },
      dark: {
        bg: "#12151d",
        fg: "#eef0f4",
        muted: "#a0a8b8",
        border: "#2b3140",
        primary: "#e6eaf2",
        primaryFg: "#12151d",
        accent: "#e2b45a",
        success: "#86efac",
        danger: "#fca5a5",
      },
    },
    fonts: { heading: "playfairDisplay", body: "inter" },
    radius: "sm",
    shape: {
      button: "square",
      card: "sm",
      headingWeight: 600,
      headingTracking: "normal",
      heroScrim: 45,
    },
  },
};

export const DEFAULT_PRESET: PresetKey = "minimal";

/** Configurația completă a unui preset, fără logo/favicon/OG (se setă din admin). */
export function configFromPreset(key: PresetKey): BrandingConfig {
  const preset = PRESETS[key];
  return {
    preset: key,
    colors: structuredClone(preset.colors),
    fonts: { ...preset.fonts },
    radius: preset.radius,
    darkMode: false,
    logoUrl: null,
    faviconUrl: null,
    ogImageUrl: null,
  };
}

/**
 * Oglinda valorilor din `packages/ui/src/styles/admin-tokens.css` de care are nevoie garda de contrast a brandului din admin
 * (`admin-brand.ts`): fundalul paginii pe fiecare temă (textul de pe brand, `--on-brand`, are aceeași culoare). Stau aici pentru că hex-urile sunt permise doar
 * în fișierul de tokeni și în acest fișier; `admin-brand.test.ts` citește fișierul de tokeni și pică dacă valorile diverg.
 */
export const ADMIN_BRAND_REFERENCE = {
  light: { page: "#ffffff" },
  dark: { page: "#121315" },
} as const;
