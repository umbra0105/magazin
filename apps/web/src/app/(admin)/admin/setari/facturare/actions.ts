"use server";

import { z } from "zod";
import { getSettingSchema, isInvoiceProviderCode, type SettingKey } from "@ecom/core";
import { errorCodeOf } from "@/lib/error-code";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { getInvoicingConfig } from "@/lib/invoicing";
import { parseUnitNames } from "@/lib/invoicing-texts";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Configurarea facturării: `/admin/setari/facturare`. TOATE acțiunile cer `invoices.configure` (doar Owner).
 *
 *  - cheile ajung la server în clar DOAR aici, se salvează criptat (`IntegrationService`, AES-256-GCM) și nu se întorc niciodată
 *    spre interfață, nici mascate: răspunsurile conțin doar «câmpul X e salvat»;
 *  - jurnalul de audit conține numele câmpurilor schimbate, modul și starea de activare, NICIODATĂ valorile;
 *  - trecerea în LIVE cere confirmare explicită ȘI marca «testat cu cont real», pusă doar de acțiunea explicită a unui Owner,
 *    după o conexiune de test reușită; fără ea serverul refuză LIVE.
 */
const PERMISSION = "invoices.configure" as const;

const providerForm = z.strictObject({
  provider: z.string().min(1).max(20),
  credentials: z.record(z.string().max(40), z.string().max(400)).default({}),
  mode: z.enum(["test", "live"]).optional(),
  isActive: z.boolean().optional(),
  confirmLive: z.boolean().optional(),
});

export type SaveInvoicingResult =
  { ok: true; revertedToTest: boolean } | { ok: false; code: string };

export const saveInvoicingConfig = withPermission(
  PERMISSION,
  async (raw: unknown, subject): Promise<SaveInvoicingResult> => {
    const parsed = providerForm.safeParse(raw);
    if (!parsed.success || !isInvoiceProviderCode(parsed.data.provider)) {
      return { ok: false, code: "INVOICING_CREDENTIALS_INVALID" };
    }
    const data = parsed.data;
    const config = getInvoicingConfig();
    try {
      const before = await config.state(data.provider);
      const result = await config.save(data.provider, {
        credentials: data.credentials,
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.confirmLive !== undefined ? { confirmLive: data.confirmLive } : {}),
      });
      if (result.changedFields.length > 0 || result.revertedToTest) {
        const after = await config.state(data.provider);
        // doar structura: ce câmpuri s-au schimbat, mod, activare; fără nicio valoare de credențială
        await getAudit().record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "invoicing.provider.save",
          entity: "invoicing_provider",
          entityId: data.provider,
          before: { mode: before.mode, isActive: before.isActive, saved: before.saved },
          after: {
            mode: after.mode,
            isActive: after.isActive,
            saved: after.saved,
            changedFields: result.changedFields,
            revertedToTest: result.revertedToTest,
            verifiedCleared: result.verifiedCleared,
          },
        });
      }
      return { ok: true, revertedToTest: result.revertedToTest };
    } catch (error) {
      const code = errorCodeOf(error, ["INVOICING_"]);
      if (code) return { ok: false, code };
      throw error;
    }
  },
  { action: "invoicing.provider.save", entity: "invoicing_provider" },
);

const codeForm = z.strictObject({ provider: z.string().min(1).max(20) });

export type InvoicingCheckResult = { ok: boolean; message: string };

export const testInvoicingConnection = withPermission(
  PERMISSION,
  async (raw: unknown, subject): Promise<InvoicingCheckResult> => {
    const parsed = codeForm.safeParse(raw);
    if (!parsed.success || !isInvoiceProviderCode(parsed.data.provider)) {
      return { ok: false, message: "Furnizor necunoscut." };
    }
    let result: InvoicingCheckResult;
    try {
      result = await getInvoicingConfig().testConnection(parsed.data.provider);
    } catch {
      result = { ok: false, message: "Verificarea conexiunii a eșuat." };
    }
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "invoicing.provider.test",
      entity: "invoicing_provider",
      entityId: parsed.data.provider,
      after: { ok: result.ok },
      outcome: result.ok ? "success" : "failed",
    });
    return result;
  },
  { action: "invoicing.provider.test", entity: "invoicing_provider" },
);

export const confirmInvoicingVerified = withPermission(
  PERMISSION,
  async (raw: unknown, subject): Promise<InvoicingCheckResult> => {
    const parsed = codeForm.safeParse(raw);
    if (!parsed.success || !isInvoiceProviderCode(parsed.data.provider)) {
      return { ok: false, message: "Furnizor necunoscut." };
    }
    let result: InvoicingCheckResult;
    try {
      result = await getInvoicingConfig().confirmVerifiedInSandbox(parsed.data.provider);
    } catch {
      result = { ok: false, message: "Confirmarea nu a reușit." };
    }
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "invoicing.provider.confirm-verified",
      entity: "invoicing_provider",
      entityId: parsed.data.provider,
      after: { ok: result.ok },
      outcome: result.ok ? "success" : "failed",
    });
    return result;
  },
  { action: "invoicing.provider.confirm-verified", entity: "invoicing_provider" },
);

const choiceForm = z.strictObject({ provider: z.enum(["", "smartbill", "demo"]) });

export type SaveInvoicingChoiceResult = { ok: true } | { ok: false; code: string };

export const saveInvoicingChoice = withPermission(
  PERMISSION,
  async (raw: unknown, subject): Promise<SaveInvoicingChoiceResult> => {
    const parsed = choiceForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    if (parsed.data.provider === "demo" && !getInvoicingConfig().visibleCodes().includes("demo")) {
      // DEMO nu poate fi ales dacă garda nu îl permite (în producție lipsește din ecran și se refuză și aici)
      return { ok: false, code: "INVOICING_DEMO_FORBIDDEN" };
    }
    await getAdminWrites().updateSetting(
      { key: "invoicing.provider", value: parsed.data.provider },
      { id: subject.userId, label: subject.email },
    );
    return { ok: true };
  },
  { action: "invoicing.provider.choose", entity: "setting" },
);

const textsForm = z.strictObject({
  shippingLabel: z.string().max(200),
  codFeeLabel: z.string().max(200),
  serviceUnit: z.string().max(200),
  unitNames: z.string().max(4000),
  sendEmailByProvider: z.boolean(),
});

export type SaveInvoicingTextsResult = { ok: true } | { ok: false; errors: Record<string, string> };

export const saveInvoicingTexts = withPermission(
  PERMISSION,
  async (raw: unknown, subject): Promise<SaveInvoicingTextsResult> => {
    const parsed = textsForm.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const data = parsed.data;
    const errors: Record<string, string> = {};
    const unitNames = parseUnitNames(data.unitNames);
    if (unitNames === null) errors["unitNames"] = "invalid";
    const next: Array<[SettingKey, unknown, string]> = [
      ["invoicing.shippingLabel", data.shippingLabel.trim(), "shippingLabel"],
      ["invoicing.codFeeLabel", data.codFeeLabel.trim(), "codFeeLabel"],
      ["invoicing.serviceUnit", data.serviceUnit.trim(), "serviceUnit"],
      ["invoicing.unitNames", unitNames ?? {}, "unitNames"],
      ["invoicing.sendEmailByProvider", data.sendEmailByProvider, "sendEmailByProvider"],
    ];
    for (const [key, value, field] of next) {
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
  { action: "invoicing.texts.update", entity: "setting" },
);
