"use server";

import { z } from "zod";
import { PaymentConfigError, isProviderCode } from "@ecom/core";
import { getAdminWrites, getAudit } from "@/lib/admin-writes";
import { getPaymentConfig } from "@/lib/payments";
import { withPermission } from "@/lib/session";

/**
 * Configurarea furnizorilor de plată cu card: `/admin/setari/plati`. TOATE acțiunile cer `payments.configure` (doar Owner).
 *
 *  - credențialele ajung la server în clar DOAR în aceste acțiuni, se salvează criptat (`IntegrationService`, AES-256-GCM) și nu
 *    se întorc niciodată spre interfață, nici mascate: răspunsurile conțin doar «câmpul X e salvat»;
 *  - jurnalul de audit conține numele câmpurilor schimbate, modul și starea de activare, NICIODATĂ valorile;
 *  - trecerea în LIVE cere confirmare explicită și marca «verificat în sandbox» (verificate pe server, în serviciu); nu există
 *    nicio altă cale prin care un furnizor să ajungă în LIVE (nici seed, nici CI, nici teste).
 */
const providerForm = z.strictObject({
  provider: z.string().min(1).max(20),
  credentials: z.record(z.string().max(40), z.string().max(8000)).default({}),
  mode: z.enum(["test", "live"]).optional(),
  isActive: z.boolean().optional(),
  confirmLive: z.boolean().optional(),
  demoRefund: z.enum(["confirmed", "pending", "failed", "manual_required"]).optional(),
});

export type SaveProviderResult =
  { ok: true; revertedToTest: boolean } | { ok: false; code: string; field?: string };

export const saveProviderConfig = withPermission(
  "payments.configure",
  async (raw: unknown, subject): Promise<SaveProviderResult> => {
    const parsed = providerForm.safeParse(raw);
    if (!parsed.success || !isProviderCode(parsed.data.provider)) {
      return { ok: false, code: "PAYMENT_CREDENTIALS_INVALID" };
    }
    const data = parsed.data;
    const config = getPaymentConfig();
    try {
      const before = await config.state(data.provider);
      const result = await config.save(data.provider, {
        credentials: data.credentials,
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.confirmLive !== undefined ? { confirmLive: data.confirmLive } : {}),
        ...(data.demoRefund ? { demoRefund: data.demoRefund } : {}),
      });
      if (result.changedFields.length > 0 || result.revertedToTest) {
        const after = await config.state(data.provider);
        // doar structura: ce câmpuri s-au schimbat, mod, activare; fără nicio valoare de credențială
        await getAudit().record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "payment.provider.save",
          entity: "payment_provider",
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
      if (error instanceof PaymentConfigError) return { ok: false, code: error.code };
      throw error;
    }
  },
  { action: "payment.provider.save", entity: "payment_provider" },
);

const testForm = z.strictObject({ provider: z.string().min(1).max(20) });

export type TestConnectionResult = { ok: boolean; message: string };

export const testProviderConnection = withPermission(
  "payments.configure",
  async (raw: unknown, subject): Promise<TestConnectionResult> => {
    const parsed = testForm.safeParse(raw);
    if (!parsed.success || !isProviderCode(parsed.data.provider)) {
      return { ok: false, message: "Furnizor necunoscut." };
    }
    let result: TestConnectionResult;
    try {
      result = await getPaymentConfig().testConnection(parsed.data.provider);
    } catch (error) {
      result = {
        ok: false,
        message:
          error instanceof PaymentConfigError ? error.message : "Verificarea conexiunii a eșuat.",
      };
    }
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "payment.provider.test",
      entity: "payment_provider",
      entityId: parsed.data.provider,
      after: { ok: result.ok },
      outcome: result.ok ? "success" : "failed",
    });
    return result;
  },
  { action: "payment.provider.test", entity: "payment_provider" },
);

const choiceForm = z.strictObject({ provider: z.enum(["", "netopia", "euplatesc", "demo"]) });

export type SaveChoiceResult = { ok: true } | { ok: false; code: string };

export const saveCardProviderChoice = withPermission(
  "payments.configure",
  async (raw: unknown, subject): Promise<SaveChoiceResult> => {
    const parsed = choiceForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    if (parsed.data.provider === "demo") {
      // DEMO nu poate fi ales dacă garda nu îl permite (în producție lipsește din ecran și se refuză și aici)
      const visible = getPaymentConfig().visibleCodes();
      if (!visible.includes("demo")) return { ok: false, code: "PAYMENT_DEMO_FORBIDDEN" };
    }
    await getAdminWrites().updateSetting(
      { key: "payment.cardProvider", value: parsed.data.provider },
      { id: subject.userId, label: subject.email },
    );
    return { ok: true };
  },
  { action: "payment.card-provider.save", entity: "setting" },
);
