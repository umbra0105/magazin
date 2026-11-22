"use server";

import { z } from "zod";
import { getSettingSchema, type SettingKey } from "@ecom/core";
import { getAdminWrites } from "@/lib/admin-writes";
import { parseMoneyInput } from "@/lib/money-input";
import { parseScaledInput } from "@/lib/scaled-input";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Setările transportului paletizat (`/admin/setari/paleti`), cu `settings.write`. Prețul și pragul se citesc în lei (cel mult 2
 * zecimale) și se salvează în bani; capacitatea în kg (3 zecimale → grame) și în m³ (6 zecimale → cm³), toate ca întregi, fără
 * `float`. Fiecare valoare se validează cu schema ei din registrul de setări; scrierea trece prin `AdminWrites` (audit al
 * diferenței, doar pentru ce s-a schimbat).
 */
const input = z.strictObject({
  price: z.string().max(40),
  threshold: z.string().max(40),
  maxWeightKg: z.string().max(40),
  maxVolumeM3: z.string().max(40),
  manualCarriers: z.string().max(5000),
});

export type SavePalletResult = { ok: true } | { ok: false; errors: Record<string, string> };

export const savePalletSettings = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SavePalletResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const data = parsed.data;
    const errors: Record<string, string> = {};

    const price = parseMoneyInput(data.price);
    if (price === null || price < 1) errors["price"] = "invalid";
    const threshold = parseMoneyInput(data.threshold);
    if (threshold === null) errors["threshold"] = "invalid";
    const maxWeightGrams = parseScaledInput(data.maxWeightKg, 3);
    if (maxWeightGrams === null || maxWeightGrams < 1) errors["maxWeight"] = "invalid";
    const maxVolumeCm3 = parseScaledInput(data.maxVolumeM3, 6);
    if (maxVolumeCm3 === null || maxVolumeCm3 < 1) errors["maxVolume"] = "invalid";
    const carriers = [
      ...new Set(
        data.manualCarriers
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      ),
    ];

    const next: Array<[SettingKey, unknown, string]> = [
      ["shipping.palletPriceMinor", price, "price"],
      ["shipping.palletSwitchThresholdMinor", threshold, "threshold"],
      ["shipping.palletMaxWeightGrams", maxWeightGrams, "maxWeight"],
      ["shipping.palletMaxVolumeCm3", maxVolumeCm3, "maxVolume"],
      ["shipping.manualCarriers", carriers, "manualCarriers"],
    ];
    for (const [key, value, field] of next) {
      if (value === null) continue; // eroarea e deja pe câmp
      const schema = getSettingSchema(key);
      if (schema && !schema.safeParse(value).success) errors[field] = "invalid";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const settings = getSettings();
    for (const [key, value] of next) {
      const current = await settings.get(key);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      await getAdminWrites().updateSetting(
        { key, value },
        { id: subject.userId, label: subject.email },
      );
    }
    return { ok: true };
  },
  { action: "pallet-settings.update", entity: "setting" },
);
