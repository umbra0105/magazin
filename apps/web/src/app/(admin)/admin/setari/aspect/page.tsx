import type { Metadata } from "next";
import {
  ANNOUNCEMENT_MAX_LENGTH,
  ANNOUNCEMENT_TONES,
  CARD_LAYOUTS,
  COLOR_TOKENS,
  CONTAINER_WIDTHS,
  CUSTOM_CSS_MAX_LENGTH,
  FONT_FAMILIES,
  FOOTER_VARIANTS,
  HEADER_VARIANTS,
  PRESET_KEYS,
  PRESETS,
  RADIUS_KEYS,
  can,
  configFromPreset,
  type BrandingConfig,
} from "@ecom/core";
import {
  AppearanceEditor,
  type AppearanceOptions,
} from "@/components/admin/appearance/appearance-editor";
import type { BrandingForm } from "@/components/admin/appearance/appearance-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getBranding, getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.appearance;

export const metadata: Metadata = { title: m.title };

const toForm = (config: BrandingConfig): BrandingForm => ({
  preset: config.preset,
  colors: { light: { ...config.colors.light }, dark: { ...config.colors.dark } },
  fonts: { ...config.fonts },
  radius: config.radius,
  darkMode: config.darkMode,
  logoUrl: config.logoUrl ?? "",
  faviconUrl: config.faviconUrl ?? "",
  ogImageUrl: config.ogImageUrl ?? "",
  customCss: config.customCss,
});

/** Editorul de temă (Nivel 2). Cere `settings.read`; salvarea cere `settings.write` (verificat și în acțiune). */
export default async function AppearancePage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const [config, appearance, general] = await Promise.all([
    getBranding().getConfig(),
    getSettings().getGroup("appearance"),
    getSettings().getGroup("general"),
  ]);
  const canSave = can(subject, "settings.write");

  const options: AppearanceOptions = {
    colorTokens: [...COLOR_TOKENS],
    fonts: Object.entries(FONT_FAMILIES).map(([key, font]) => ({
      key: key as keyof typeof FONT_FAMILIES,
      label: font.label,
    })),
    radii: [...RADIUS_KEYS],
    presets: PRESET_KEYS.map((key) => ({
      key,
      label: PRESETS[key].label,
      form: toForm(configFromPreset(key)),
    })),
    headerVariants: [...HEADER_VARIANTS],
    footerVariants: [...FOOTER_VARIANTS],
    containerWidths: [...CONTAINER_WIDTHS],
    cardLayouts: [...CARD_LAYOUTS],
    announcementTones: [...ANNOUNCEMENT_TONES],
    announcementMaxLength: ANNOUNCEMENT_MAX_LENGTH,
    customCssMaxLength: CUSTOM_CSS_MAX_LENGTH,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} description={m.description} notes={canSave ? [] : [m.readOnly]} />
      <AppearanceEditor
        canSave={canSave}
        storeName={general.storeName}
        options={options}
        initial={{
          branding: toForm(config),
          settings: {
            headerVariant: appearance.headerVariant,
            footerVariant: appearance.footerVariant,
            containerWidth: appearance.containerWidth,
            cardLayout: appearance.cardLayout,
            announcementEnabled: appearance.announcementEnabled,
            announcementText: appearance.announcementText,
            announcementHref: appearance.announcementHref,
            announcementTone: appearance.announcementTone,
          },
        }}
      />
    </div>
  );
}
