"use server";

import { z } from "zod";
import { FEATURE_KEYS } from "@ecom/core";
import { getAdminWrites } from "@/lib/admin-writes";
import { withPermission } from "@/lib/session";

/**
 * Scrierile din admin, ca server actions FĂRĂ interfață (paginile reale vin în Fazele 6/16). Fiecare:
 *  1. validează intrarea cu Zod la graniță;
 *  2. e împachetată cu `withPermission` (verificare pe server; refuzul se înregistrează în audit);
 *  3. scrie prin `AdminWrites`, care înregistrează în audit doar diferențele, fără valori sensibile.
 * Rezultatul nu conține date sensibile.
 */

const actor = (subject: { userId: string; email: string }) => ({
  id: subject.userId,
  label: subject.email,
});

const settingInput = z.object({ key: z.string().min(1).max(100), value: z.unknown() });

export const updateSetting = withPermission(
  "settings.write",
  async (input: unknown, subject) => {
    await getAdminWrites().updateSetting(settingInput.parse(input), actor(subject));
    return { ok: true as const };
  },
  { action: "settings.update", entity: "setting" },
);

const flagInput = z.object({ key: z.enum(FEATURE_KEYS), enabled: z.boolean() });

export const setFeatureFlag = withPermission(
  "settings.write",
  async (input: unknown, subject) => {
    await getAdminWrites().setFeatureFlag(flagInput.parse(input), actor(subject));
    return { ok: true as const };
  },
  { action: "feature_flag.update", entity: "feature_flag" },
);

export const saveBranding = withPermission(
  "settings.write",
  async (input: unknown, subject) => {
    // Validarea strictă (culori, fonturi, contrast) e în `BrandingService.save`.
    const { warnings } = await getAdminWrites().saveBranding(input, actor(subject));
    return { ok: true as const, warnings };
  },
  { action: "branding.update", entity: "branding" },
);

const integrationInput = z.object({
  type: z.string().min(1).max(50),
  provider: z.string().min(1).max(50),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.unknown().optional(),
  isActive: z.boolean().optional(),
});

export const saveIntegration = withPermission(
  "integrations.write",
  async (input: unknown, subject) => {
    const parsed = integrationInput.parse(input);
    await getAdminWrites().saveIntegration(
      {
        type: parsed.type,
        provider: parsed.provider,
        ...(parsed.credentials && { credentials: parsed.credentials }),
        ...(parsed.config !== undefined && { config: parsed.config }),
        ...(parsed.isActive !== undefined && { isActive: parsed.isActive }),
      },
      actor(subject),
    );
    return { ok: true as const };
  },
  { action: "integration.update", entity: "integration" },
);
