"use server";

import { z } from "zod";
import {
  FreeShippingExclusionService,
  SHIPPING_CLASSES,
  getSettingSchema,
  isValidCalendarDate,
  type FreeShippingExclusionDto,
  type SettingKey,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { DomainError } from "@ecom/shared";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { parseMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Setările coșului, transportului, plății și numerotării comenzilor din admin (`/admin/setari/cos`). Cere `settings.write`;
 * fiecare valoare se validează cu schema ei din registrul de setări (o singură sursă), sumele se citesc în lei (virgulă sau
 * punct, cel mult 2 zecimale) și se salvează în bani; scrierea trece prin `AdminWrites` (audit al diferenței, doar pentru ce s-a
 * schimbat). Erorile se întorc pe câmp. Rambursul la produse «La comandă» NU e setare: regulă fixă în cod.
 */
const input = z.strictObject({
  threshold: z.string().max(40),
  classes: z.array(z.enum(SHIPPING_CLASSES)).max(3),
  pickupEnabled: z.boolean(),
  groundNotice: z.string().max(2000),
  codIndividual: z.string().max(40),
  codCompany: z.string().max(40),
  supportRefundLimit: z.string().max(40),
  orderPrefix: z.string().max(40),
  orderDigits: z.number().int(),
  nonWorkingDates: z.string().max(20_000),
});

export type SaveCartSettingsResult = { ok: true } | { ok: false; errors: Record<string, string> };

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const saveCartSettings = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SaveCartSettingsResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const data = parsed.data;
    const errors: Record<string, string> = {};

    const thresholdText = data.threshold.trim();
    const threshold = thresholdText === "" ? null : parseMoneyInput(thresholdText);
    if (thresholdText !== "" && (threshold === null || threshold < 1))
      errors["threshold"] = "invalid";

    const codIndividual = parseMoneyInput(data.codIndividual.trim());
    if (codIndividual === null) errors["codIndividual"] = "invalid";
    const codCompany = parseMoneyInput(data.codCompany.trim());
    if (codCompany === null) errors["codCompany"] = "invalid";

    const supportRefundLimit = parseMoneyInput(data.supportRefundLimit.trim());
    if (supportRefundLimit === null) errors["supportRefundLimit"] = "invalid";

    const dates = [
      ...new Set(
        data.nonWorkingDates
          .split(/[\n,;]+/)
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      ),
    ].sort();
    if (!dates.every(isValidCalendarDate)) errors["nonWorkingDates"] = "invalid";

    const next: Array<[SettingKey, unknown]> = [
      ["checkout.freeShippingThreshold", threshold],
      ["checkout.freeShippingClasses", SHIPPING_CLASSES.filter((c) => data.classes.includes(c))],
      ["shipping.pickupEnabled", data.pickupEnabled],
      ["shipping.groundLevelNotice", data.groundNotice.trim()],
      ["payment.codMaxAmountIndividual", codIndividual],
      ["payment.codMaxAmountCompany", codCompany],
      ["payment.supportRefundLimit", supportRefundLimit],
      ["checkout.orderNumberPrefix", data.orderPrefix.trim()],
      ["checkout.orderNumberDigits", data.orderDigits],
      ["regional.nonWorkingDates", dates],
    ];
    const fieldOf: Partial<Record<SettingKey, string>> = {
      "shipping.groundLevelNotice": "groundNotice",
      "checkout.orderNumberPrefix": "orderPrefix",
      "checkout.orderNumberDigits": "orderDigits",
    };
    for (const [key, value] of next) {
      if (value === null && key !== "checkout.freeShippingThreshold") continue; // eroarea e deja pe câmp
      const schema = getSettingSchema(key);
      if (schema && !schema.safeParse(value).success) errors[fieldOf[key] ?? key] = "invalid";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const settings = getSettings();
    for (const [key, value] of next) {
      const current = await settings.get(key);
      if (sameValue(current, value)) continue;
      await getAdminWrites().updateSetting(
        { key, value },
        { id: subject.userId, label: subject.email },
      );
    }
    return { ok: true };
  },
  { action: "cart-settings.update", entity: "setting" },
);

export type ExclusionResult =
  | { ok: true; items: FreeShippingExclusionDto[] }
  | { ok: false; code: "not_found" | "invalid" | "failed" };

const sku = z.strictObject({ sku: z.string().max(100) });

export const addFreeShippingExclusion = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<ExclusionResult> => {
    const parsed = sku.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const service = new FreeShippingExclusionService(getDb());
    try {
      const added = await service.addBySku(parsed.data.sku);
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "free-shipping-exclusion.add",
        entity: "product",
        entityId: added.productId,
        after: { productId: added.productId, title: added.title, sku: added.sku },
      });
      return { ok: true, items: await service.list() };
    } catch (error) {
      if (error instanceof DomainError && error.code === "FREE_SHIPPING_SKU_NOT_FOUND") {
        return { ok: false, code: "not_found" };
      }
      throw error;
    }
  },
  { action: "free-shipping-exclusion.add", entity: "product" },
);

const productRef = z.strictObject({ productId: z.string().min(1).max(64) });

export const removeFreeShippingExclusion = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<ExclusionResult> => {
    const parsed = productRef.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const service = new FreeShippingExclusionService(getDb());
    const before = (await service.list()).find(
      (entry) => entry.productId === parsed.data.productId,
    );
    if (await service.remove(parsed.data.productId)) {
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "free-shipping-exclusion.remove",
        entity: "product",
        entityId: parsed.data.productId,
        before,
      });
    }
    return { ok: true, items: await service.list() };
  },
  { action: "free-shipping-exclusion.remove", entity: "product" },
);
