import type { BrandingConfig, ColorSet, ColorToken } from "./tokens";

/** WCAG 2.x, nivel AA pentru text normal. */
export const WCAG_AA_NORMAL_TEXT = 4.5;

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminanța relativă a unei culori `#rrggbb` (WCAG). */
export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** Raportul de contrast dintre două culori `#rrggbb`, între 1 și 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Perechile text/fundal verificate: `[text, fundal]`. */
export const CONTRAST_PAIRS: readonly [ColorToken, ColorToken][] = [
  ["fg", "bg"],
  ["muted", "bg"],
  ["primaryFg", "primary"],
  ["accent", "bg"],
  ["success", "bg"],
  ["danger", "bg"],
];

export interface ContrastWarning {
  mode: "light" | "dark";
  foreground: ColorToken;
  background: ColorToken;
  ratio: number;
  required: number;
}

function checkSet(mode: "light" | "dark", colors: ColorSet): ContrastWarning[] {
  return CONTRAST_PAIRS.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(colors[foreground], colors[background]);
    return ratio < WCAG_AA_NORMAL_TEXT
      ? [{ mode, foreground, background, ratio: Math.round(ratio * 100) / 100, required: 4.5 }]
      : [];
  });
}

/**
 * Perechile care nu ating AA. Paleta întunecată se verifică doar dacă `darkMode` e pornit.
 * Rezultatul e doar informativ (avertisment în admin): salvarea nu se blochează.
 */
export function checkContrast(
  config: Pick<BrandingConfig, "colors" | "darkMode">,
): ContrastWarning[] {
  return [
    ...checkSet("light", config.colors.light),
    ...(config.darkMode ? checkSet("dark", config.colors.dark) : []),
  ];
}
