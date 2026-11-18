"use server";

import { z } from "zod";
import { getAdminWrites } from "@/lib/admin-writes";
import { getSettings } from "@/lib/services";
import { parseMoneyInput } from "@/lib/money-input";
import { withPermission } from "@/lib/session";

/**
 * Setările coșului din admin: pragul de transport gratuit (`checkout.freeShippingThreshold`, bani întregi; gol = dezactivat).
 * Cere `settings.write`; valoarea se citește ca sumă în lei (virgulă sau punct, cel mult 2 zecimale) și se validează cu schema
 * din registrul de setări (o singură sursă); scrierea trece prin `AdminWrites` (audit al diferenței). Erorile se întorc pe câmp.
 */
const input = z.strictObject({ threshold: z.string().max(40) });

export type SaveCartSettingsResult = { ok: true } | { ok: false; errors: Record<string, string> };

export const saveCartSettings = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SaveCartSettingsResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { threshold: "invalid" } };
    const text = parsed.data.threshold.trim();
    const minor = text === "" ? null : parseMoneyInput(text);
    if (text !== "" && (minor === null || minor < 1)) {
      return { ok: false, errors: { threshold: "invalid" } };
    }
    const current = await getSettings().get("checkout.freeShippingThreshold");
    if (current !== minor) {
      await getAdminWrites().updateSetting(
        { key: "checkout.freeShippingThreshold", value: minor },
        { id: subject.userId, label: subject.email },
      );
    }
    return { ok: true };
  },
  { action: "cart-settings.update", entity: "setting" },
);
