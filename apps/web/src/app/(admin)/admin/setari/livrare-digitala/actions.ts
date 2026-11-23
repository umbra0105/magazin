"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DELIVERY_PROVIDERS } from "@ecom/core";
import { REAL_DELIVERY_CODES, getSettingSchema, type SettingKey } from "@ecom/core";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { getDeliveryConfig } from "@/lib/digital";
import { errorCodeOf } from "@/lib/error-code";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Livrarea conținutului digital din admin (`/admin/setari/livrare-digitala`, Faza 14b).
 *  - setările (furnizorii aleși, valabilitatea linkurilor, mărimea maximă, pragurile de alertă, păstrarea IP-ului, textul bifei):
 *    `settings.write`, fiecare valoare validată cu schema ei din registru, scrise prin `AdminWrites` (audit al diferenței);
 *  - cheile furnizorilor (Bunny Stream, S3), testul de conexiune, «am testat cu un cont real» și activarea: `digital.configure`
 *    (doar Owner). Valorile cheilor NU intră în audit și nu se întorc niciodată spre interfață: auditul are doar NUMELE câmpurilor.
 */
type Fail = { ok: false; code: string };
export type DeliveryActionResult<T = object> = ({ ok: true } & T) | Fail;

const PREFIXES = ["DIGITAL_", "VALIDATION_", "AUTH_"] as const;
const failure = (error: unknown): Fail => ({
  ok: false,
  code: errorCodeOf(error, PREFIXES) ?? "failed",
});

const provider = z.enum(REAL_DELIVERY_CODES as unknown as [string, ...string[]]);

const settingsInput = z.strictObject({
  videoProvider: z.enum(["local", "bunny"]),
  fileProvider: z.enum(["local", "s3"]),
  linkSeconds: z.number().int(),
  maxUploadMb: z.number().int(),
  maxIpsPerEntitlement: z.number().int(),
  ipWindowHours: z.number().int(),
  accessLogRetentionDays: z.number().int(),
  consentText: z.string().max(2000),
});

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const saveDeliverySettingsAction = withPermission(
  "settings.write",
  async (
    raw: unknown,
    subject,
  ): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> => {
    const parsed = settingsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const data = parsed.data;
    const next: Array<[SettingKey, unknown, string]> = [
      ["digital.videoProvider", data.videoProvider, "videoProvider"],
      ["digital.fileProvider", data.fileProvider, "fileProvider"],
      ["digital.linkSeconds", data.linkSeconds, "linkSeconds"],
      ["digital.maxUploadMb", data.maxUploadMb, "maxUploadMb"],
      ["digital.maxIpsPerEntitlement", data.maxIpsPerEntitlement, "maxIpsPerEntitlement"],
      ["digital.ipWindowHours", data.ipWindowHours, "ipWindowHours"],
      ["digital.accessLogRetentionDays", data.accessLogRetentionDays, "accessLogRetentionDays"],
      ["digital.consentText", data.consentText.trim(), "consentText"],
    ];
    const errors: Record<string, string> = {};
    for (const [key, value, field] of next) {
      const schema = getSettingSchema(key);
      if (schema && !schema.safeParse(value).success) errors[field] = "invalid";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    const settings = getSettings();
    for (const [key, value] of next) {
      if (sameValue(await settings.get(key), value)) continue;
      await getAdminWrites().updateSetting(
        { key, value },
        { id: subject.userId, label: subject.email },
      );
    }
    revalidatePath("/admin/setari/livrare-digitala");
    return { ok: true };
  },
  { action: "digital-settings.update", entity: "setting" },
);

const record = (
  subject: { userId: string; email: string },
  action: string,
  code: string,
  after: Record<string, unknown> = {},
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "integration",
    entityId: `digital_delivery:${code}`,
    after,
  });

export const saveDeliveryKeysAction = withPermission(
  "digital.configure",
  async (
    raw: unknown,
    subject,
  ): Promise<DeliveryActionResult<{ changedFields: string[]; cleared: boolean }>> => {
    const parsed = z
      .strictObject({ provider, credentials: z.record(z.string().max(60), z.string().max(2000)) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_CONFIG_INVALID" };
    const code = parsed.data.provider as keyof typeof DELIVERY_PROVIDERS;
    try {
      const result = await getDeliveryConfig().save(code, parsed.data.credentials);
      // în audit intră NUMELE câmpurilor schimbate, niciodată valorile
      await record(subject, "digital-delivery.keys", code, {
        fields: result.changedFields,
        verifiedCleared: result.verifiedCleared,
        deactivated: result.deactivated,
      });
      revalidatePath("/admin/setari/livrare-digitala");
      return {
        ok: true,
        changedFields: result.changedFields,
        cleared: result.verifiedCleared || result.deactivated,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital-delivery.keys", entity: "integration" },
);

export const testDeliveryAction = withPermission(
  "digital.configure",
  async (
    raw: unknown,
  ): Promise<DeliveryActionResult<{ okConnection: boolean; message: string }>> => {
    const parsed = z.strictObject({ provider }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_CONFIG_INVALID" };
    try {
      const result = await getDeliveryConfig().testConnection(parsed.data.provider);
      return { ok: true, okConnection: result.ok, message: result.message };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital-delivery.test", entity: "integration" },
);

export const confirmDeliveryAction = withPermission(
  "digital.configure",
  async (raw: unknown, subject): Promise<DeliveryActionResult> => {
    const parsed = z.strictObject({ provider, confirmed: z.literal(true) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_CONFIG_INVALID" };
    try {
      await getDeliveryConfig().confirmVerified(parsed.data.provider);
      await record(subject, "digital-delivery.verify", parsed.data.provider);
      revalidatePath("/admin/setari/livrare-digitala");
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital-delivery.verify", entity: "integration" },
);

export const setDeliveryActiveAction = withPermission(
  "digital.configure",
  async (raw: unknown, subject): Promise<DeliveryActionResult> => {
    const parsed = z.strictObject({ provider, active: z.boolean() }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_CONFIG_INVALID" };
    try {
      await getDeliveryConfig().setActive(parsed.data.provider, parsed.data.active);
      await record(subject, "digital-delivery.active", parsed.data.provider, {
        active: parsed.data.active,
      });
      revalidatePath("/admin/setari/livrare-digitala");
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital-delivery.active", entity: "integration" },
);
