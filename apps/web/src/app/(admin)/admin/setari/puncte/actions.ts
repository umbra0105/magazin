"use server";

import { z } from "zod";
import { getSettingSchema, type SettingKey } from "@ecom/core";
import { getAdminWrites } from "@/lib/admin-writes";
import { parseMoneyInput } from "@/lib/money-input";
import { getFeatureFlags, getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Setările programului «Puncte de loialitate» (`/admin/setari/puncte`, Faza 15b). Cere `loyalty.configure`; fiecare valoare se
 * validează cu schema ei din registrul de setări, sumele se citesc în lei și se salvează în bani; scrierea trece prin
 * `AdminWrites` (audit al diferenței, doar pentru ce s-a schimbat). Tratamentul TVA poate fi gol sau «reducere pe factură».
 */
const input = z.strictObject({
  enabled: z.boolean(),
  vatMode: z.enum(["", "base_reduced"]),
  earnRate: z.string().max(40),
  earnOnDiscountedItems: z.boolean(),
  pointValue: z.string().max(40),
  minRedeemPoints: z.string().max(10),
  maxRedeemPercent: z.string().max(10),
  minCashAmount: z.string().max(40),
  expiryMonths: z.string().max(10),
  expiryWarningDays: z.string().max(10),
  releasedGraceDays: z.string().max(10),
});

export type SaveLoyaltySettingsResult =
  { ok: true } | { ok: false; errors: Record<string, string> };

const integer = (text: string): number | null =>
  /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : null;

export const saveLoyaltySettings = withPermission(
  "loyalty.configure",
  async (raw: unknown, subject): Promise<SaveLoyaltySettingsResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success || !(await getFeatureFlags().isEnabled("loyalty"))) {
      return { ok: false, errors: { form: "invalid" } };
    }
    const data = parsed.data;
    const percentText = data.maxRedeemPercent.trim();
    const next: Array<[string, SettingKey, unknown]> = [
      ["vatMode", "loyalty.vatMode", data.vatMode === "" ? null : data.vatMode],
      ["earnRate", "loyalty.earnRate", parseMoneyInput(data.earnRate.trim())],
      ["earnOnDiscountedItems", "loyalty.earnOnDiscountedItems", data.earnOnDiscountedItems],
      ["pointValue", "loyalty.pointValue", parseMoneyInput(data.pointValue.trim())],
      ["minRedeemPoints", "loyalty.minRedeemPoints", integer(data.minRedeemPoints)],
      [
        "maxRedeemPercent",
        "loyalty.maxRedeemPercent",
        // gol = fără plafon; un text greșit rămâne greșit (nu devine «fără plafon»)
        percentText === "" ? null : (integer(percentText) ?? percentText),
      ],
      ["minCashAmount", "loyalty.minCashAmount", parseMoneyInput(data.minCashAmount.trim())],
      ["expiryMonths", "loyalty.expiryMonths", integer(data.expiryMonths)],
      ["expiryWarningDays", "loyalty.expiryWarningDays", integer(data.expiryWarningDays)],
      ["releasedGraceDays", "loyalty.releasedGraceDays", integer(data.releasedGraceDays)],
      // pornirea vine ultima: programul nu pornește cu reguli salvate pe jumătate
      ["enabled", "loyalty.enabled", data.enabled],
    ];
    const errors: Record<string, string> = {};
    for (const [field, key, value] of next) {
      const schema = getSettingSchema(key);
      if (!schema || !schema.safeParse(value).success) errors[field] = "invalid";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const settings = getSettings();
    for (const [, key, value] of next) {
      const current = await settings.get(key);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      await getAdminWrites().updateSetting(
        { key, value },
        { id: subject.userId, label: subject.email },
      );
    }
    return { ok: true };
  },
  { action: "loyalty-settings.update", entity: "setting" },
);
