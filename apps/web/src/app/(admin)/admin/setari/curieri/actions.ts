"use server";

import { z } from "zod";
import { isCarrierCode } from "@ecom/core";
import { errorCodeOf } from "@/lib/error-code";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { getCarrierConfig, getCarrierRuntime } from "@/lib/shipping";
import { withPermission } from "@/lib/session";

/**
 * Configurarea curierilor: `/admin/setari/curieri`. TOATE acțiunile cer `integrations.write` (doar Owner).
 *
 *  - cheile ajung la server în clar DOAR aici, se salvează criptat (`IntegrationService`, AES-256-GCM) și nu se întorc niciodată
 *    spre interfață, nici mascate: răspunsurile conțin doar «câmpul X e salvat»;
 *  - jurnalul de audit conține numele câmpurilor schimbate, modul și starea de activare, NICIODATĂ valorile;
 *  - trecerea în LIVE cere confirmare explicită ȘI marca «testat cu cont real», pusă doar de acțiunea explicită a unui Owner,
 *    după o conexiune de test reușită; fără ea serverul refuză LIVE.
 */
const providerForm = z.strictObject({
  provider: z.string().min(1).max(20),
  credentials: z.record(z.string().max(40), z.string().max(2000)).default({}),
  mode: z.enum(["test", "live"]).optional(),
  isActive: z.boolean().optional(),
  confirmLive: z.boolean().optional(),
});

export type SaveCarrierResult = { ok: true; revertedToTest: boolean } | { ok: false; code: string };

export const saveCarrierConfig = withPermission(
  "integrations.write",
  async (raw: unknown, subject): Promise<SaveCarrierResult> => {
    const parsed = providerForm.safeParse(raw);
    if (!parsed.success || !isCarrierCode(parsed.data.provider)) {
      return { ok: false, code: "SHIPPING_CREDENTIALS_INVALID" };
    }
    const data = parsed.data;
    const config = getCarrierConfig();
    try {
      const before = await config.state(data.provider);
      const result = await config.save(data.provider, {
        credentials: data.credentials,
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.confirmLive !== undefined ? { confirmLive: data.confirmLive } : {}),
      });
      getCarrierRuntime().invalidate();
      if (result.changedFields.length > 0 || result.revertedToTest) {
        const after = await config.state(data.provider);
        // doar structura: ce câmpuri s-au schimbat, mod, activare; fără nicio valoare de credențială
        await getAudit().record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "shipping.carrier.save",
          entity: "shipping_carrier",
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
      const code = errorCodeOf(error, ["SHIPPING_"]);
      if (code) return { ok: false, code };
      throw error;
    }
  },
  { action: "shipping.carrier.save", entity: "shipping_carrier" },
);

const codeForm = z.strictObject({ provider: z.string().min(1).max(20) });

export type CarrierCheckResult = { ok: boolean; message: string };

export const testCarrierConnection = withPermission(
  "integrations.write",
  async (raw: unknown, subject): Promise<CarrierCheckResult> => {
    const parsed = codeForm.safeParse(raw);
    if (!parsed.success || !isCarrierCode(parsed.data.provider)) {
      return { ok: false, message: "Curier necunoscut." };
    }
    let result: CarrierCheckResult;
    try {
      result = await getCarrierConfig().testConnection(parsed.data.provider);
    } catch {
      result = { ok: false, message: "Verificarea conexiunii a eșuat." };
    }
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "shipping.carrier.test",
      entity: "shipping_carrier",
      entityId: parsed.data.provider,
      after: { ok: result.ok },
      outcome: result.ok ? "success" : "failed",
    });
    return result;
  },
  { action: "shipping.carrier.test", entity: "shipping_carrier" },
);

export const confirmCarrierVerified = withPermission(
  "integrations.write",
  async (raw: unknown, subject): Promise<CarrierCheckResult> => {
    const parsed = codeForm.safeParse(raw);
    if (!parsed.success || !isCarrierCode(parsed.data.provider)) {
      return { ok: false, message: "Curier necunoscut." };
    }
    let result: CarrierCheckResult;
    try {
      result = await getCarrierConfig().confirmVerifiedInSandbox(parsed.data.provider);
    } catch {
      result = { ok: false, message: "Confirmarea nu a reușit." };
    }
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "shipping.carrier.confirm-verified",
      entity: "shipping_carrier",
      entityId: parsed.data.provider,
      after: { ok: result.ok },
      outcome: result.ok ? "success" : "failed",
    });
    return result;
  },
  { action: "shipping.carrier.confirm-verified", entity: "shipping_carrier" },
);

const choiceForm = z.strictObject({ provider: z.enum(["", "wootpro", "sameday", "demo"]) });

export type SaveCarrierChoiceResult = { ok: true } | { ok: false; code: string };

export const saveCarrierChoice = withPermission(
  "integrations.write",
  async (raw: unknown, subject): Promise<SaveCarrierChoiceResult> => {
    const parsed = choiceForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    if (parsed.data.provider === "demo") {
      // DEMO nu poate fi ales dacă garda nu îl permite (în producție lipsește din ecran și se refuză și aici)
      if (!getCarrierConfig().visibleCodes().includes("demo")) {
        return { ok: false, code: "SHIPPING_DEMO_FORBIDDEN" };
      }
    }
    await getAdminWrites().updateSetting(
      { key: "shipping.carrier", value: parsed.data.provider },
      { id: subject.userId, label: subject.email },
    );
    getCarrierRuntime().invalidate();
    return { ok: true };
  },
  { action: "shipping.carrier.choose", entity: "setting" },
);
