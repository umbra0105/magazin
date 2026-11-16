import type {
  AnnouncementTone,
  CardLayout,
  ColorToken,
  ContainerWidth,
  FontKey,
  FooterVariant,
  HeaderVariant,
  PresetKey,
  RadiusKey,
} from "@ecom/core";

/**
 * Starea formularului «Aspect» (tot text, cum vine din câmpuri) și conversiile spre/dinspre ce așteaptă acțiunea de salvare.
 * Logica pură, fără React: se poate testa pe valori. Validarea reală e pe server (`appearanceInputSchema`); aici doar
 * comoditățile din interfață (formatul culorii, ce câmpuri s-au modificat).
 */
export type ColorValues = Record<ColorToken, string>;

export interface BrandingForm {
  preset: PresetKey;
  colors: { light: ColorValues; dark: ColorValues };
  fonts: { heading: FontKey; body: FontKey };
  radius: RadiusKey;
  darkMode: boolean;
  logoUrl: string;
  faviconUrl: string;
  ogImageUrl: string;
  customCss: string;
}

export interface SettingsForm {
  headerVariant: HeaderVariant;
  footerVariant: FooterVariant;
  containerWidth: ContainerWidth;
  cardLayout: CardLayout;
  announcementEnabled: boolean;
  announcementText: string;
  announcementHref: string;
  announcementTone: AnnouncementTone;
}

export interface AppearanceForm {
  branding: BrandingForm;
  settings: SettingsForm;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#rgb` sau `#rrggbb` (comoditate pentru mostră și mesaj imediat; serverul validează oricum). */
export const isHexColor = (value: string): boolean => HEX.test(value.trim());

function trimColors(colors: ColorValues): ColorValues {
  return Object.fromEntries(
    Object.entries(colors).map(([token, value]) => [token, value.trim()]),
  ) as ColorValues;
}

/** Valoarea trimisă serverului: adresele goale devin `null`, restul se trimite așa cum e (serverul normalizează și validează). */
export function toSavePayload(form: AppearanceForm) {
  const url = (value: string): string | null => (value.trim() === "" ? null : value.trim());
  return {
    branding: {
      ...form.branding,
      colors: {
        light: trimColors(form.branding.colors.light),
        dark: trimColors(form.branding.colors.dark),
      },
      logoUrl: url(form.branding.logoUrl),
      faviconUrl: url(form.branding.faviconUrl),
      ogImageUrl: url(form.branding.ogImageUrl),
    },
    settings: {
      ...form.settings,
      announcementText: form.settings.announcementText.trim(),
      announcementHref: form.settings.announcementHref.trim(),
    },
  };
}

/** Ce trimite previzualizarea: doar tema (fără setările de pagină). */
export const toPreviewBranding = (form: AppearanceForm) => toSavePayload(form).branding;

/** Formularul s-a schimbat față de starea salvată? Compară reprezentările trimise, deci spațiile de la capete nu contează. */
export function isDirty(current: AppearanceForm, saved: AppearanceForm): boolean {
  return JSON.stringify(toSavePayload(current)) !== JSON.stringify(toSavePayload(saved));
}

/**
 * Înlocuiește culorile, fonturile și raza cu cele ale presetului; restul (logo, favicon, imagine de partajare, mod închis, CSS
 * personalizat) rămâne cum e.
 */
export function applyPreset(form: BrandingForm, preset: BrandingForm): BrandingForm {
  return {
    ...form,
    preset: preset.preset,
    colors: { light: { ...preset.colors.light }, dark: { ...preset.colors.dark } },
    fonts: { ...preset.fonts },
    radius: preset.radius,
  };
}

/** Erorile serverului vin cu calea `branding.…` sau `settings.…` (la salvare) ori fără prefix (la previzualizare): se aduc la o formă. */
export function normalizeErrors(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([key, message]) => [key.replace(/^branding\./, ""), message]),
  );
}
