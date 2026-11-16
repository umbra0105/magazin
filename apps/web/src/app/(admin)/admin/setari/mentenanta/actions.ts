"use server";

import { issuesByField, settingGroups } from "@ecom/core";
import { z } from "zod";
import { getAdminWrites } from "@/lib/admin-writes";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Modul de mentenanță: pornit/oprit și mesajul. Cere `settings.write`; validare cu schemele din registrul de setări (o singură
 * sursă), scriere prin `AdminWrites` (audit al diferențelor). Erorile de validare se întorc pe câmp, nu se aruncă.
 */
const input = z.strictObject(settingGroups.maintenance);

export type SaveMaintenanceResult = { ok: true } | { ok: false; errors: Record<string, string> };

export const saveMaintenance = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SaveMaintenanceResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: issuesByField(parsed.error) };
    const actor = { id: subject.userId, label: subject.email };
    const current = await getSettings().getGroup("maintenance");
    const writes = getAdminWrites();
    for (const [name, value] of Object.entries(parsed.data)) {
      if (current[name as keyof typeof current] === value) continue;
      await writes.updateSetting({ key: `maintenance.${name}`, value }, actor);
    }
    return { ok: true };
  },
  { action: "maintenance.update", entity: "setting" },
);
