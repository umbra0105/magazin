import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import { IntegrationService } from "../integrations/integration-service";
import type { PrismaClient } from "@ecom/db";
import {
  DomainError,
  type ConnectionTestResult,
  type PaymentMode,
  type PaymentProvider,
  type PaymentProviderCode,
} from "@ecom/shared";
import {
  buildPaymentProvider,
  isDemoPaymentAllowed,
  parsePublicKey,
  type DemoGuardEnv,
  type FetchLike,
} from "@ecom/integrations";
import {
  PAYMENT_INTEGRATION_TYPE,
  PROVIDERS,
  isProviderCode,
  missingRequiredFields,
} from "./provider-fields";

/**
 * Configurarea furnizorilor de plată (Faza 10), peste `IntegrationService` (credențiale criptate AES-256-GCM, tipul «payment»):
 *  - credențialele NU se întorc niciodată spre interfață, nici mascate: starea publică spune doar ce câmpuri sunt salvate;
 *  - modul test/live; trecerea în LIVE cere confirmare explicită ȘI marca `verifiedInSandboxAt` (o plată de probă confirmată cu
 *    semnătură validă) și se refuză pe server altfel; schimbarea credențialelor șterge marca și readuce modul în test;
 *  - furnizorul DEMO există doar dacă garda `isDemoPaymentAllowed` o permite;
 *  - un furnizor se poate folosi la plăți noi doar dacă e activ, complet configurat și (la LIVE) verificat în sandbox.
 */

export const PAYMENT_CONFIG_CODES = [
  "PAYMENT_PROVIDER_UNKNOWN",
  "PAYMENT_DEMO_FORBIDDEN",
  "PAYMENT_NOT_CONFIGURED",
  "PAYMENT_CREDENTIALS_INVALID",
  "PAYMENT_LIVE_CONFIRMATION_REQUIRED",
  "PAYMENT_LIVE_NOT_VERIFIED",
] as const;

export class PaymentConfigError extends DomainError {
  constructor(code: (typeof PAYMENT_CONFIG_CODES)[number], message: string, details?: unknown) {
    super(code, message, details);
  }
}

export type ConfigMode = "test" | "live";

export interface ProviderState {
  code: PaymentProviderCode;
  label: string;
  real: boolean;
  /** Toate câmpurile obligatorii sunt salvate. */
  configured: boolean;
  /** Ce câmpuri au valoare salvată (doar «da/nu», niciodată valoarea). */
  saved: Record<string, boolean>;
  isActive: boolean;
  mode: ConfigMode;
  verifiedInSandboxAt: Date | null;
  /** E furnizorul ales pentru butonul «Card online» (`payment.cardProvider`). */
  selectedForCard: boolean;
}

export interface SaveProviderInput {
  /** Doar câmpurile completate; cele goale păstrează valoarea salvată. */
  credentials?: Readonly<Record<string, string>>;
  mode?: ConfigMode;
  isActive?: boolean;
  /** Confirmarea explicită a trecerii în LIVE. */
  confirmLive?: boolean;
  /** Doar DEMO: cum răspunde la rambursare. */
  demoRefund?: "confirmed" | "pending" | "failed" | "manual_required";
}

export interface SaveProviderResult {
  /** Numele câmpurilor schimbate (NICIODATĂ valorile): pentru jurnalul de audit. */
  changedFields: string[];
  modeBefore: ConfigMode;
  modeAfter: ConfigMode;
  activeBefore: boolean;
  activeAfter: boolean;
  /** Credențialele s-au schimbat în modul LIVE: modul a revenit în test, iar marca de verificare s-a șters. */
  revertedToTest: boolean;
  verifiedCleared: boolean;
}

export interface PaymentConfigDeps {
  db: PrismaClient;
  appKey: string;
  env: DemoGuardEnv;
  /** Valoarea setării `payment.cardProvider`. */
  readCardProvider: () => Promise<string>;
  now?: () => Date;
  fetch?: FetchLike;
}

interface Row {
  credentials: Record<string, string> | null;
  isActive: boolean;
  mode: ConfigMode;
  demoRefund: NonNullable<SaveProviderInput["demoRefund"]>;
  verifiedInSandboxAt: Date | null;
}

const MAX_FIELD = 8000;

export class PaymentConfigService {
  private readonly integrations: IntegrationService;
  private readonly now: () => Date;

  constructor(private readonly deps: PaymentConfigDeps) {
    this.integrations = new IntegrationService(createPrismaIntegrationStore(deps.db), deps.appKey);
    this.now = deps.now ?? (() => new Date());
  }

  private assertCode(code: string): PaymentProviderCode {
    if (!isProviderCode(code)) {
      throw new PaymentConfigError("PAYMENT_PROVIDER_UNKNOWN", "Furnizor de plată necunoscut");
    }
    if (code === "demo" && !isDemoPaymentAllowed(this.deps.env)) {
      throw new PaymentConfigError(
        "PAYMENT_DEMO_FORBIDDEN",
        "Furnizorul DEMO nu este disponibil în această instalare",
      );
    }
    return code;
  }

  private async row(code: PaymentProviderCode): Promise<Row> {
    const found = await this.deps.db.integration.findUnique({
      where: { type_provider: { type: PAYMENT_INTEGRATION_TYPE, provider: code } },
    });
    const config = (found?.config ?? {}) as { mode?: unknown; demoRefund?: unknown };
    const demoRefund =
      config.demoRefund === "pending" ||
      config.demoRefund === "failed" ||
      config.demoRefund === "manual_required"
        ? config.demoRefund
        : "confirmed";
    return {
      credentials: found?.credentials
        ? await this.integrations.getCredentials(PAYMENT_INTEGRATION_TYPE, code)
        : null,
      isActive: found?.isActive ?? false,
      mode: config.mode === "live" ? "live" : "test",
      demoRefund,
      verifiedInSandboxAt: found?.verifiedInSandboxAt ?? null,
    };
  }

  /** Furnizorii vizibili în ecran: DEMO doar dacă garda o permite. */
  visibleCodes(): PaymentProviderCode[] {
    return (Object.keys(PROVIDERS) as PaymentProviderCode[]).filter(
      (code) => code !== "demo" || isDemoPaymentAllowed(this.deps.env),
    );
  }

  async state(codeInput: string): Promise<ProviderState> {
    const code = this.assertCode(codeInput);
    const info = PROVIDERS[code];
    const row = await this.row(code);
    const selected = (await this.deps.readCardProvider()) === code;
    return {
      code,
      label: info.label,
      real: info.real,
      configured: !info.real || missingRequiredFields(code, row.credentials).length === 0,
      saved: Object.fromEntries(
        info.fields.map((field) => [field.key, (row.credentials?.[field.key] ?? "").trim() !== ""]),
      ),
      isActive: row.isActive,
      mode: info.real ? row.mode : "test",
      verifiedInSandboxAt: row.verifiedInSandboxAt,
      selectedForCard: selected,
    };
  }

  async list(): Promise<ProviderState[]> {
    return Promise.all(this.visibleCodes().map((code) => this.state(code)));
  }

  /**
   * Furnizorul pe care îl folosește acum butonul «Card online», sau `null` (cardul nu se oferă). Condiții: ales în setări,
   * activ, complet configurat și, la LIVE, verificat în sandbox. DEMO doar dacă garda o permite.
   */
  async activeCardProvider(): Promise<{ code: PaymentProviderCode; mode: PaymentMode } | null> {
    const chosen = await this.deps.readCardProvider();
    if (!chosen || !isProviderCode(chosen)) return null;
    if (chosen === "demo") {
      if (!isDemoPaymentAllowed(this.deps.env)) return null;
      const row = await this.row("demo");
      return row.isActive ? { code: "demo", mode: "demo" } : null;
    }
    const row = await this.row(chosen);
    if (!row.isActive) return null;
    if (missingRequiredFields(chosen, row.credentials).length > 0) return null;
    if (row.mode === "live" && !row.verifiedInSandboxAt) return null;
    return { code: chosen, mode: row.mode };
  }

  /**
   * Adaptorul pentru un furnizor (credențiale decriptate, doar pe server), sau `null` dacă nu e configurat. NU cere ca furnizorul
   * să fie activ: notificările și rambursările plăților deja făcute trebuie să funcționeze și după dezactivare.
   */
  async getProvider(codeInput: string): Promise<PaymentProvider | null> {
    if (!isProviderCode(codeInput)) return null;
    if (codeInput === "demo" && !isDemoPaymentAllowed(this.deps.env)) return null;
    const row = await this.row(codeInput);
    if (codeInput !== "demo" && missingRequiredFields(codeInput, row.credentials).length > 0) {
      return null;
    }
    return buildPaymentProvider({
      code: codeInput,
      credentials: row.credentials ?? {},
      mode: row.mode,
      env: this.deps.env,
      appKey: this.deps.appKey,
      demoRefundBehavior: row.demoRefund,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      now: this.now,
    });
  }

  async save(codeInput: string, input: SaveProviderInput): Promise<SaveProviderResult> {
    const code = this.assertCode(codeInput);
    const info = PROVIDERS[code];
    const row = await this.row(code);

    // credențialele: doar câmpurile cunoscute, completate; cele goale păstrează valoarea salvată
    const merged: Record<string, string> = { ...(row.credentials ?? {}) };
    const changedFields: string[] = [];
    for (const field of info.fields) {
      const value = input.credentials?.[field.key]?.trim();
      if (value === undefined || value === "") continue;
      if (value.length > MAX_FIELD) {
        throw new PaymentConfigError(
          "PAYMENT_CREDENTIALS_INVALID",
          `${field.label}: valoare prea lungă`,
        );
      }
      if (merged[field.key] !== value) {
        merged[field.key] = value;
        changedFields.push(field.key);
      }
    }
    this.validateFormats(code, merged);

    const credentialsChanged = changedFields.length > 0;
    let mode: ConfigMode = info.real ? row.mode : "test";
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
          throw new PaymentConfigError(
            "PAYMENT_LIVE_CONFIRMATION_REQUIRED",
            "Trecerea în LIVE cere confirmare explicită.",
          );
        }
        if (!verified) {
          throw new PaymentConfigError(
            "PAYMENT_LIVE_NOT_VERIFIED",
            "Trecerea în LIVE e refuzată: nu există încă o plată de probă (mod test) confirmată prin notificare cu semnătură validă. Fă o plată de probă, apoi încearcă din nou.",
          );
        }
      }
      mode = input.mode;
      changedFields.push("mode");
    }

    const isActive = input.isActive ?? row.isActive;
    if (isActive && info.real && missingRequiredFields(code, merged).length > 0) {
      throw new PaymentConfigError(
        "PAYMENT_NOT_CONFIGURED",
        `Nu poți activa furnizorul: lipsesc ${missingRequiredFields(code, merged).join(", ")}.`,
      );
    }
    if (isActive !== row.isActive) changedFields.push("isActive");
    if (code === "demo" && input.demoRefund !== undefined && input.demoRefund !== row.demoRefund) {
      changedFields.push("demoRefund");
    }

    await this.integrations.save({
      type: PAYMENT_INTEGRATION_TYPE,
      provider: code,
      ...(info.real ? { credentials: merged } : {}),
      config: {
        mode,
        ...(code === "demo" ? { demoRefund: input.demoRefund ?? row.demoRefund } : {}),
      },
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

  private validateFormats(code: PaymentProviderCode, credentials: Record<string, string>): void {
    const bad = (message: string): never => {
      throw new PaymentConfigError("PAYMENT_CREDENTIALS_INVALID", message);
    };
    if (code === "euplatesc") {
      const hex = /^(?:[0-9a-fA-F]{2})+$/;
      if (credentials["secretKey"] && !hex.test(credentials["secretKey"])) {
        bad(
          "Cheia secretă EuPlătesc trebuie să fie hexazecimală (cifre și litere a-f, număr par de caractere).",
        );
      }
      if (credentials["userApi"] && !hex.test(credentials["userApi"])) {
        bad("Parola utilizatorului API EuPlătesc trebuie să fie hexazecimală.");
      }
    }
    if (
      code === "netopia" &&
      credentials["publicKey"] &&
      !parsePublicKey(credentials["publicKey"])
    ) {
      bad("Cheia publică Netopia nu este o cheie RSA validă (PEM sau certificat).");
    }
  }

  async testConnection(codeInput: string): Promise<ConnectionTestResult> {
    const code = this.assertCode(codeInput);
    const provider = await this.getProvider(code);
    if (!provider) {
      const row = await this.row(code);
      const missing = missingRequiredFields(code, row.credentials);
      return {
        ok: false,
        message: `Date incomplete: lipsesc ${missing.join(", ") || "credențialele"}.`,
      };
    }
    return provider.testConnection();
  }

  /** Setează marca «verificat în sandbox» (o singură dată; nu o mută). Doar pentru plăți făcute în modul test. */
  async markVerifiedInSandbox(code: PaymentProviderCode): Promise<void> {
    if (!PROVIDERS[code].real) return;
    await this.deps.db.integration.updateMany({
      where: {
        type: PAYMENT_INTEGRATION_TYPE,
        provider: code,
        verifiedInSandboxAt: null,
      },
      data: { verifiedInSandboxAt: this.now() },
    });
  }
}

/** Variabilele de mediu care decid dacă furnizorul DEMO e permis (vezi `isDemoPaymentAllowed`). */
export function readDemoGuardEnv(): DemoGuardEnv {
  return {
    NODE_ENV: process.env["NODE_ENV"],
    E2E_HARNESS: process.env["E2E_HARNESS"],
    ECOM_DEMO_PAYMENTS: process.env["ECOM_DEMO_PAYMENTS"],
  };
}
