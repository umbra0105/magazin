"use server";

import {
  appearanceInputSchema,
  brandingConfigSchema,
  checkContrast,
  issuesByField,
  renderScopedThemeCss,
  type ContrastWarning,
} from "@ecom/core";
import { z } from "zod";
import { getAdminWrites } from "@/lib/admin-writes";
import { withPermission } from "@/lib/session";
import { getSettings } from "@/lib/services";

/**
 * Editorul de temă (Nivel 2). Două acțiuni, ambele cu verificare de permisiune pe server:
 *  - `previewAppearance` (`settings.read`): validează tema din formular și întoarce CSS-ul previzualizării (doar valori
 *    validate) și avertismentele de contrast; nu scrie nimic;
 *  - `saveAppearance` (`settings.write`): validează tot formularul, scrie tema (`branding.update`) și setările de aspect care s-au
 *    schimbat (`setting.update`), prin `AdminWrites` (audit al diferențelor). Erorile de validare se întorc pe câmp, nu se aruncă.
 */
const actor = (subject: { userId: string; email: string }) => ({
  id: subject.userId,
  label: subject.email,
});

export type PreviewResult =
  | { ok: true; css: string; warnings: ContrastWarning[] }
  | { ok: false; errors: Record<string, string> };

const previewInput = z.object({ branding: z.unknown(), mode: z.enum(["light", "dark"]) });

export const previewAppearance = withPermission(
  "settings.read",
  async (input: unknown): Promise<PreviewResult> => {
    const { branding, mode } = previewInput.parse(input);
    const parsed = brandingConfigSchema.safeParse(branding);
    if (!parsed.success) return { ok: false, errors: issuesByField(parsed.error) };
    return {
      ok: true,
      css: renderScopedThemeCss(parsed.data, mode),
      // în previzualizare se verifică ambele teme, ca editorul să semnaleze și paleta închisă
      warnings: checkContrast({ colors: parsed.data.colors, darkMode: true }),
    };
  },
  { action: "appearance.preview", entity: "branding" },
);

export type SaveAppearanceResult =
  { ok: true; warnings: ContrastWarning[] } | { ok: false; errors: Record<string, string> };

export const saveAppearance = withPermission(
  "settings.write",
  async (input: unknown, subject): Promise<SaveAppearanceResult> => {
    const parsed = appearanceInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: issuesByField(parsed.error) };
    const writes = getAdminWrites();
    const { warnings } = await writes.saveBranding(parsed.data.branding, actor(subject));
    const current = await getSettings().getGroup("appearance");
    for (const [name, value] of Object.entries(parsed.data.settings)) {
      if (current[name as keyof typeof current] === value) continue;
      await writes.updateSetting({ key: `appearance.${name}`, value }, actor(subject));
    }
    return { ok: true, warnings };
  },
  { action: "appearance.update", entity: "branding" },
);
