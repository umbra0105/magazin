import type { PrismaClient } from "@ecom/db";
import {
  DomainError,
  SHIPPING_PROVIDER_CODES,
  type ConnectionTestResult,
  type ShippingCarrier,
  type ShippingMode,
  type ShippingProviderCode,
} from "@ecom/shared";
import {
  buildShippingCarrier,
  isDemoPaymentAllowed,
  type DemoGuardEnv,
  type FetchLike,
} from "@ecom/integrations";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";

/**
 * Configurarea curierilor (Faza 12), peste `IntegrationService` (credențiale criptate AES-256-GCM, tipul «shipping»), cu aceleași
 * garanții ca la plăți:
 *  - credențialele NU se întorc niciodată spre interfață: starea publică spune doar ce câmpuri sunt salvate;
 *  - mod test/LIVE; trecerea în LIVE cere confirmare explicită ȘI marca `verifiedInSandboxAt`, pusă DOAR de Owner prin
 *    «Confirm că am testat cu un cont real» și refuzată pe server altfel; schimbarea credențialelor șterge marca și readuce modul
 *    în test;
 *  - un curier se folosește doar dacă e ales în `shipping.carrier`, activ, complet configurat și (în LIVE) verificat;
 *  - curierul DEMO există doar dacă garda `isDemoPaymentAllowed` o permite.
 * Toți adaptorii sunt «încă netestați cu un cont real» până la confirmarea utilizatorului.
 */
export const SHIPPING_INTEGRATION_TYPE = "shipping";

export const SHIPPING_CONFIG_CODES = [
  "SHIPPING_PROVIDER_UNKNOWN",
  "SHIPPING_DEMO_FORBIDDEN",
  "SHIPPING_NOT_CONFIGURED",
  "SHIPPING_CREDENTIALS_INVALID",
  "SHIPPING_LIVE_CONFIRMATION_REQUIRED",
  "SHIPPING_LIVE_NOT_VERIFIED",
] as const;

export class ShippingConfigError extends DomainError {
  constructor(code: (typeof SHIPPING_CONFIG_CODES)[number], message: string, details?: unknown) {
    super(code, message, details);
  }
}

export interface CarrierField {
  key: string;
  label: string;
  required: boolean;
  /** Valoare secretă (nu se afișează niciodată după salvare; câmp de parolă). */
  secret: boolean;
  hint?: string;
}

export interface CarrierInfo {
  code: ShippingProviderCode;
  label: string;
  fields: readonly CarrierField[];
  /** Curier real (mod test/LIVE și garda «verificat în sandbox»). */
  real: boolean;
  /** Ce nu e confirmat pentru acest adaptor (afișat în ecran). */
  notes: readonly string[];
}

export const CARRIERS: Readonly<Record<ShippingProviderCode, CarrierInfo>> = {
  wootpro: {
    code: "wootpro",
    label: "wootPRO (agregator)",
    real: true,
    fields: [
      { key: "publicKey", label: "Cheie publică (32 de caractere)", required: true, secret: false },
      { key: "secretKey", label: "Cheie secretă (32 de caractere)", required: true, secret: true },
      {
        key: "senderAddressId",
        label: "ID adresă expeditor din contul wootPRO",
        required: true,
        secret: false,
        hint: "Numărul adresei de ridicare, din secțiunea de adrese a contului.",
      },
    ],
    notes: [
      "Încă netestat cu un cont real: construit după specificația publică și verificat doar cu răspunsuri simulate.",
      "Fără AWB de retur și fără etichetă ZPL în API; fără taxă de ramburs în răspunsul de tarife; starea se citește prin sondare.",
    ],
  },
  sameday: {
    code: "sameday",
    label: "Sameday (direct, easybox)",
    real: true,
    fields: [
      { key: "username", label: "Utilizator API", required: true, secret: false },
      { key: "password", label: "Parolă API", required: true, secret: true },
      {
        key: "pickupPointId",
        label: "ID punct de ridicare",
        required: true,
        secret: false,
        hint: "Din lista punctelor de ridicare ale contului (diferă între demo și producție).",
      },
      {
        key: "defaultServiceId",
        label: "ID serviciu implicit",
        required: true,
        secret: false,
        hint: "Din lista serviciilor contului (diferă între demo și producție).",
      },
    ],
    notes: [
      "Încă netestat cu un cont real; documentația oficială nu a putut fi citită integral: căile și răspunsurile din afara autentificării sunt presupuse.",
      "Fără AWB de retur prin API și fără etichetă ZPL; punctele easybox vin dintr-un endpoint presupus.",
    ],
  },
  demo: {
    code: "demo",
    label: "DEMO (doar dezvoltare)",
    real: false,
    fields: [],
    notes: ["Curier simulat: nu contactează niciun serviciu real."],
  },
};

export const isCarrierCode = (value: string): value is ShippingProviderCode =>
  (SHIPPING_PROVIDER_CODES as readonly string[]).includes(value);

export function missingCarrierFields(
  code: ShippingProviderCode,
  credentials: Readonly<Record<string, string>> | null,
): string[] {
  return CARRIERS[code].fields
    .filter((field) => field.required && !(credentials?.[field.key] ?? "").trim())
    .map((field) => field.label);
}

export interface CarrierState {
  code: ShippingProviderCode;
  label: string;
  real: boolean;
  configured: boolean;
  /** Ce câmpuri au valoare salvată (doar «da/nu», niciodată valoarea). */
  saved: Record<string, boolean>;
  isActive: boolean;
  mode: ShippingMode;
  verifiedInSandboxAt: Date | null;
  /** E curierul ales în `shipping.carrier`. */
  selected: boolean;
  notes: readonly string[];
}

export interface SaveCarrierInput {
  /** Doar câmpurile completate; cele goale păstrează valoarea salvată. */
  credentials?: Readonly<Record<string, string>>;
  mode?: ShippingMode;
  isActive?: boolean;
  confirmLive?: boolean;
}

export interface SaveCarrierResult {
  /** Numele câmpurilor schimbate (NICIODATĂ valorile): pentru jurnalul de audit. */
  changedFields: string[];
  modeBefore: ShippingMode;
  modeAfter: ShippingMode;
  activeBefore: boolean;
  activeAfter: boolean;
  revertedToTest: boolean;
  verifiedCleared: boolean;
}

export interface CarrierConfigDeps {
  db: PrismaClient;
  appKey: string;
  env: DemoGuardEnv;
  /** Valoarea setării `shipping.carrier`. */
  readSelected: () => Promise<string>;
  now?: () => Date;
  fetch?: FetchLike;
}

interface Row {
  credentials: Record<string, string> | null;
  isActive: boolean;
  mode: ShippingMode;
  verifiedInSandboxAt: Date | null;
}

const MAX_FIELD = 2000;

export class CarrierConfigService {
  private readonly integrations: IntegrationService;
  private readonly now: () => Date;

  constructor(private readonly deps: CarrierConfigDeps) {
    this.integrations = new IntegrationService(createPrismaIntegrationStore(deps.db), deps.appKey);
    this.now = deps.now ?? (() => new Date());
  }

  private assertCode(code: string): ShippingProviderCode {
    if (!isCarrierCode(code)) {
      throw new ShippingConfigError("SHIPPING_PROVIDER_UNKNOWN", "Curier necunoscut");
    }
    if (code === "demo" && !isDemoPaymentAllowed(this.deps.env)) {
      throw new ShippingConfigError(
        "SHIPPING_DEMO_FORBIDDEN",
        "Curierul DEMO nu este disponibil în această instalare",
      );
    }
    return code;
  }

  private async row(code: ShippingProviderCode): Promise<Row> {
    const found = await this.deps.db.integration.findUnique({
      where: { type_provider: { type: SHIPPING_INTEGRATION_TYPE, provider: code } },
    });
    const config = (found?.config ?? {}) as { mode?: unknown };
    return {
      credentials: found?.credentials
        ? await this.integrations.getCredentials(SHIPPING_INTEGRATION_TYPE, code)
        : null,
      isActive: found?.isActive ?? false,
      mode: config.mode === "live" ? "live" : "test",
      verifiedInSandboxAt: found?.verifiedInSandboxAt ?? null,
    };
  }

  visibleCodes(): ShippingProviderCode[] {
    return SHIPPING_PROVIDER_CODES.filter(
      (code) => code !== "demo" || isDemoPaymentAllowed(this.deps.env),
    );
  }

  async state(codeInput: string): Promise<CarrierState> {
    const code = this.assertCode(codeInput);
    const info = CARRIERS[code];
    const row = await this.row(code);
    return {
      code,
      label: info.label,
      real: info.real,
      configured: !info.real || missingCarrierFields(code, row.credentials).length === 0,
      saved: Object.fromEntries(
        info.fields.map((field) => [field.key, (row.credentials?.[field.key] ?? "").trim() !== ""]),
      ),
      isActive: row.isActive,
      mode: info.real ? row.mode : "test",
      verifiedInSandboxAt: row.verifiedInSandboxAt,
      selected: (await this.deps.readSelected()) === code,
      notes: info.notes,
    };
  }

  list(): Promise<CarrierState[]> {
    return Promise.all(this.visibleCodes().map((code) => this.state(code)));
  }

  /**
   * Curierul pe care îl folosește acum magazinul, sau `null`: ales în setări, activ, complet configurat și, în LIVE, verificat
   * în sandbox. DEMO doar dacă garda o permite.
   */
  async activeCarrier(): Promise<{ code: ShippingProviderCode; mode: ShippingMode } | null> {
    const chosen = await this.deps.readSelected();
    if (!chosen || !isCarrierCode(chosen)) return null;
    if (chosen === "demo") {
      if (!isDemoPaymentAllowed(this.deps.env)) return null;
      const row = await this.row("demo");
      return row.isActive ? { code: "demo", mode: "test" } : null;
    }
    const row = await this.row(chosen);
    if (!row.isActive) return null;
    if (missingCarrierFields(chosen, row.credentials).length > 0) return null;
    if (row.mode === "live" && !row.verifiedInSandboxAt) return null;
    return { code: chosen, mode: row.mode };
  }

  /**
   * Adaptorul pentru un curier (credențiale decriptate, doar pe server), sau `null` dacă nu e configurat. NU cere ca furnizorul
   * să fie activ: urmărirea și anularea AWB-urilor deja create trebuie să funcționeze și după dezactivare. Un curier în LIVE
   * neverificat nu se construiește (o garanție în plus față de ecran).
   */
  async getCarrier(codeInput: string): Promise<ShippingCarrier | null> {
    if (!isCarrierCode(codeInput)) return null;
    if (codeInput === "demo" && !isDemoPaymentAllowed(this.deps.env)) return null;
    const row = await this.row(codeInput);
    if (codeInput !== "demo") {
      if (missingCarrierFields(codeInput, row.credentials).length > 0) return null;
      if (row.mode === "live" && !row.verifiedInSandboxAt) return null;
    }
    return buildShippingCarrier({
      code: codeInput,
      credentials: row.credentials ?? {},
      mode: row.mode,
      env: this.deps.env,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      now: this.now,
    });
  }

  async save(codeInput: string, input: SaveCarrierInput): Promise<SaveCarrierResult> {
    const code = this.assertCode(codeInput);
    const info = CARRIERS[code];
    const row = await this.row(code);

    const merged: Record<string, string> = { ...(row.credentials ?? {}) };
    const changedFields: string[] = [];
    for (const field of info.fields) {
      const value = input.credentials?.[field.key]?.trim();
      if (value === undefined || value === "") continue;
      if (value.length > MAX_FIELD) {
        throw new ShippingConfigError(
          "SHIPPING_CREDENTIALS_INVALID",
          `${field.label}: valoare prea lungă`,
        );
      }
      if (merged[field.key] !== value) {
        merged[field.key] = value;
        changedFields.push(field.key);
      }
    }
    if (
      code === "wootpro" &&
      merged["senderAddressId"] &&
      !/^\d{1,12}$/.test(merged["senderAddressId"])
    ) {
      throw new ShippingConfigError(
        "SHIPPING_CREDENTIALS_INVALID",
        "ID-ul adresei de expeditor wootPRO trebuie să fie un număr.",
      );
    }
    if (code === "sameday") {
      for (const key of ["pickupPointId", "defaultServiceId"] as const) {
        if (merged[key] && !/^\d{1,12}$/.test(merged[key])) {
          throw new ShippingConfigError(
            "SHIPPING_CREDENTIALS_INVALID",
            "ID-urile Sameday (punct de ridicare, serviciu) trebuie să fie numere.",
          );
        }
      }
    }

    const credentialsChanged = changedFields.length > 0;
    let mode: ShippingMode = info.real ? row.mode : "test";
    let verified = row.verifiedInSandboxAt;
    let revertedToTest = false;
    let verifiedCleared = false;
    if (credentialsChanged && info.real) {
      if (verified) verifiedCleared = true;
      verified = null;
      if (mode === "live") {
        mode = "test";
        revertedToTest = true;
      }
    }
    if (info.real && input.mode !== undefined && input.mode !== mode) {
      if (input.mode === "live") {
        if (input.confirmLive !== true) {
          throw new ShippingConfigError(
            "SHIPPING_LIVE_CONFIRMATION_REQUIRED",
            "Trecerea în LIVE cere confirmare explicită.",
          );
        }
        if (!verified) {
          throw new ShippingConfigError(
            "SHIPPING_LIVE_NOT_VERIFIED",
            "Trecerea în LIVE e refuzată: adaptorul nu a fost încă testat cu un cont real. Testează în sandbox, apoi confirmă testul și încearcă din nou.",
          );
        }
      }
      mode = input.mode;
      changedFields.push("mode");
    }

    const isActive = input.isActive ?? row.isActive;
    if (isActive && info.real && missingCarrierFields(code, merged).length > 0) {
      throw new ShippingConfigError(
        "SHIPPING_NOT_CONFIGURED",
        `Nu poți activa curierul: lipsesc ${missingCarrierFields(code, merged).join(", ")}.`,
      );
    }
    if (isActive !== row.isActive) changedFields.push("isActive");

    await this.integrations.save({
      type: SHIPPING_INTEGRATION_TYPE,
      provider: code,
      ...(info.real ? { credentials: merged } : {}),
      config: { mode },
      isActive,
      verifiedInSandboxAt: verified,
    });
    return {
      changedFields,
      modeBefore: info.real ? row.mode : "test",
      modeAfter: mode,
      activeBefore: row.isActive,
      activeAfter: isActive,
      revertedToTest,
      verifiedCleared,
    };
  }

  async testConnection(codeInput: string): Promise<ConnectionTestResult> {
    const code = this.assertCode(codeInput);
    const carrier = await this.getCarrier(code);
    if (!carrier) {
      const row = await this.row(code);
      const missing = missingCarrierFields(code, row.credentials);
      return {
        ok: false,
        message: `Date incomplete: lipsesc ${missing.join(", ") || "credențialele"}.`,
      };
    }
    return carrier.testConnection();
  }

  /**
   * Marca «testat cu un cont real în sandbox»: o pune DOAR acțiunea explicită a unui Owner, după ce o conexiune de test a reușit
   * pe credențialele curente. Nu se pune automat de nimic altceva. Fără ea, trecerea în LIVE e refuzată.
   */
  async confirmVerifiedInSandbox(codeInput: string): Promise<{ ok: boolean; message: string }> {
    const code = this.assertCode(codeInput);
    if (!CARRIERS[code].real)
      return { ok: false, message: "Curierul DEMO nu se verifică în sandbox." };
    const row = await this.row(code);
    if (missingCarrierFields(code, row.credentials).length > 0) {
      return { ok: false, message: "Completează mai întâi credențialele." };
    }
    if (row.mode !== "test") return { ok: false, message: "Confirmarea se face în modul test." };
    const test = await this.testConnection(code);
    if (!test.ok) return { ok: false, message: `Conexiunea de test a eșuat: ${test.message}` };
    await this.deps.db.integration.updateMany({
      where: { type: SHIPPING_INTEGRATION_TYPE, provider: code },
      data: { verifiedInSandboxAt: this.now() },
    });
    return { ok: true, message: "Testul cu cont real a fost înregistrat." };
  }
}
