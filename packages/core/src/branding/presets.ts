import type { BrandingConfig, ColorSet, PresetKey } from "./tokens";

interface Preset {
  label: string;
  colors: { light: ColorSet; dark: ColorSet };
  fonts: BrandingConfig["fonts"];
  radius: BrandingConfig["radius"];
}

/** Cele 3 presets. Toate trec verificarea de contrast AA (testată în `branding.test.ts`). */
export const PRESETS: Record<PresetKey, Preset> = {
  minimal: {
    label: "Minimal",
    colors: {
      light: {
        bg: "#ffffff",
        fg: "#1a1a1a",
        muted: "#595959",
        border: "#e5e5e5",
        primary: "#1f1f1f",
        primaryFg: "#ffffff",
        accent: "#2563eb",
        success: "#15803d",
        danger: "#b91c1c",
      },
      dark: {
        bg: "#0f0f10",
        fg: "#f5f5f5",
        muted: "#a3a3a3",
        border: "#2a2a2a",
        primary: "#f5f5f5",
        primaryFg: "#111111",
        accent: "#60a5fa",
        success: "#4ade80",
        danger: "#f87171",
      },
    },
    fonts: { heading: "inter", body: "inter" },
    radius: "md",
  },
  bold: {
    label: "Bold",
    colors: {
      light: {
        bg: "#ffffff",
        fg: "#111827",
        muted: "#4b5563",
        border: "#d1d5db",
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
  },
  editorial: {
    label: "Editorial",
    colors: {
      light: {
        bg: "#faf7f2",
        fg: "#1c1917",
        muted: "#57534e",
        border: "#e7e0d5",
        primary: "#292524",
        primaryFg: "#faf7f2",
        accent: "#9a3412",
        success: "#166534",
        danger: "#991b1b",
      },
      dark: {
        bg: "#1c1917",
        fg: "#f5f0e8",
        muted: "#a8a29e",
        border: "#3a342f",
        primary: "#f5f0e8",
        primaryFg: "#1c1917",
        accent: "#fdba74",
        success: "#86efac",
        danger: "#fca5a5",
      },
    },
    fonts: { heading: "playfairDisplay", body: "lora" },
    radius: "sm",
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
