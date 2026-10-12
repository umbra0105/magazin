import { ValidationError } from "@ecom/shared";
import { createWithAudit, type AuditActor, type AuditedActionSpec } from "../audit/with-audit";
import type { AuditService } from "../audit/audit-service";
import type { BrandingService, SaveBrandingResult } from "../branding/branding-service";
import type { FeatureKey } from "../features/registry";
import type { FeatureFlagService } from "../features/feature-flag-service";
import type {
  IntegrationCredentials,
  IntegrationService,
} from "../integrations/integration-service";
import type { DeniedAttempt } from "../rbac/can";
import { getSettingSchema, type SettingKey } from "../settings/registry";
import type { SettingsService } from "../settings/settings-service";

export interface AdminWriteDeps {
  audit: AuditService;
  settings: SettingsService;
  flags: FeatureFlagService;
  branding: BrandingService;
  integrations: IntegrationService;
}

export interface SaveIntegrationCommand {
  type: string;
  provider: string;
  /** Înlocuiește integral credențialele existente; omis = rămân cele stocate. */
  credentials?: IntegrationCredentials;
  config?: unknown;
  isActive?: boolean;
}

/**
 * Starea unei integrări pentru jurnal: configurația, dacă e activă și DOAR NUMELE credențialelor
 * (`authFields`) și care dintre ele s-au înlocuit acum (`authFieldsChanged`). Numele sunt VALORI
 * într-un array, nu chei de obiect: o credențială numită `password` sau `apiKey` ar fi mascată de
 * regulile de redactare pe nume de câmp și ar pierde informația `modificat`. Valorile credențialelor
 * (nici măcar sufixul mascat `****abcd`) nu apar nicăieri.
 */
interface IntegrationAuditView {
  isActive: boolean;
  config: unknown;
  authFields: string[];
  authFieldsChanged: string[];
}

/**
 * Scrierile din admin, cu jurnal de audit. Fiecare scriere:
 *  - are actorul din sesiune (id + etichetă) și `requestId` din contextul cererii;
 *  - înregistrează doar ce s-a schimbat (diferențe, cu valoarea dinainte și de după); dacă nu s-a
 *    schimbat nimic, nu scrie nimic;
 *  - nu pune niciodată în jurnal valori sensibile: la integrări apar doar NUMELE credențialelor
 *    (`[modificat]` / `[ascuns]`), iar `AuditService` mai maschează orice câmp cu nume sensibil.
 * Permisiunea se verifică ÎNAINTE, în `withPermission` (aici se presupune acordată).
 */
export function createAdminWrites(deps: AdminWriteDeps) {
  const { audit, settings, flags, branding, integrations } = deps;

  /** Împachetează o scriere cu `withAudit`, pentru actorul dat. */
  const audited =
    <I, O>(spec: AuditedActionSpec<I, O>, handler: (input: I) => Promise<O>) =>
    (input: I, actor: AuditActor): Promise<O> =>
      createWithAudit({ audit, getActor: async () => actor })({ ...spec, diff: true }, async (i) =>
        handler(i),
      )(input);

  const requireSettingKey = (key: string): SettingKey => {
    if (!getSettingSchema(key)) throw new ValidationError(`Setare necunoscută: ${key}`);
    return key as SettingKey;
  };

  const updateSetting = audited<{ key: string; value: unknown }, unknown>(
    {
      action: "settings.update",
      entity: "setting",
      entityId: (input) => input.key,
      before: async (input) => ({ [input.key]: await settings.get(requireSettingKey(input.key)) }),
      after: (stored, input) => ({ [input.key]: stored }),
    },
    // `set` validează cu schema din registru și întoarce valoarea stocată (normalizată).
    (input) => settings.set(requireSettingKey(input.key), input.value),
  );

  const setFeatureFlag = audited<{ key: FeatureKey; enabled: boolean }, { enabled: boolean }>(
    {
      action: "feature_flag.update",
      entity: "feature_flag",
      entityId: (input) => input.key,
      before: async (input) => ({ enabled: await flags.isEnabled(input.key) }),
    },
    async (input) => {
      await flags.setEnabled(input.key, input.enabled);
      return { enabled: await flags.isEnabled(input.key) };
    },
  );

  const saveBranding = audited<unknown, SaveBrandingResult>(
    {
      action: "branding.update",
      entity: "branding",
      entityId: () => "default",
      before: () => branding.getConfig(),
      after: (result) => result.config,
    },
    // Validare strictă în serviciu; întoarce și avertismentele de contrast pentru apelant.
    (input) => branding.save(input),
  );

  const integrationView = async (
    type: string,
    provider: string,
    changedCredentialKeys: readonly string[],
  ): Promise<IntegrationAuditView | null> => {
    const view = await integrations.getPublicView(type, provider);
    if (!view) return null;
    return {
      isActive: view.isActive,
      config: view.config,
      // Doar numele; valorile (mascate de `getPublicView`) nu se folosesc.
      authFields: Object.keys(view.credentials).sort(),
      authFieldsChanged: [...changedCredentialKeys].sort(),
    };
  };

  const saveIntegration = audited<SaveIntegrationCommand, IntegrationAuditView | null>(
    {
      action: "integration.update",
      entity: "integration",
      entityId: (input) => `${input.type}:${input.provider}`,
      before: async (input) => (await integrationView(input.type, input.provider, [])) ?? {},
    },
    async (input) => {
      await integrations.save(input);
      const changed = input.credentials ? Object.keys(input.credentials) : [];
      // `changed` = cheile primite acum (înlocuiesc integral credențialele): apar ca `[modificat]`.
      return integrationView(input.type, input.provider, changed);
    },
  );

  return { updateSetting, setFeatureFlag, saveBranding, saveIntegration };
}

export type AdminWrites = ReturnType<typeof createAdminWrites>;

/**
 * Înregistrează în jurnal o încercare refuzată (rezultat `denied`): cine, ce acțiune, ce permisiune
 * lipsea și de ce. NU primește și nu înregistrează datele trimise cu încercarea (pot conține secrete).
 */
export async function recordDeniedAttempt(
  audit: AuditService,
  attempt: DeniedAttempt,
): Promise<void> {
  await audit.record({
    actorId: attempt.subject?.userId ?? null,
    actorLabel: attempt.subject?.email ?? null,
    action: attempt.action ?? "permission.check",
    entity: attempt.entity ?? "permission",
    entityId: attempt.permission,
    outcome: "denied",
    after: { permission: attempt.permission, reason: attempt.reason },
  });
}
