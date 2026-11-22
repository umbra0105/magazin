import type { PrismaClient } from "@ecom/db";
import {
  DomainError,
  INVOICE_PROVIDER_CODES,
  type ConnectionTestResult,
  type InvoiceMode,
  type InvoiceProvider,
  type InvoiceProviderCode,
} from "@ecom/shared";
import {
  buildInvoiceProvider,
  isDemoPaymentAllowed,
  type DemoGuardEnv,
  type FetchLike,
} from "@ecom/integrations";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import type { InvoiceProviderSource } from "./invoice-service";
import { selectedInvoiceProvider } from "./invoice-schedule";

/**
 * Configurarea furnizorilor de facturare (Faza 13), peste `IntegrationService` (credențiale criptate AES-256-GCM, tipul «invoicing»),
 * cu aceleași garanții ca la plăți și curieri:
 *  - credențialele NU se întorc niciodată spre interfață: starea publică spune doar ce câmpuri sunt salvate;
 *  - mod test/LIVE; trecerea în LIVE cere confirmare explicită ȘI marca `verifiedInSandboxAt`, pusă DOAR de Owner prin
 *    «Confirm că am testat cu un cont real» (după rapoartul de rotunjire fără diferențe) și refuzată pe server altfel; schimbarea
 *    credențialelor șterge marca și readuce modul în test;
 *  - un furnizor se folosește doar dacă e ales în `invoicing.provider`, activ, complet configurat și (în LIVE) verificat;
 *  - furnizorul DEMO există doar dacă garda `isDemoPaymentAllowed` o permite.
 * SmartBill nu are un mediu de test separat: «test» înseamnă credențialele unui cont de test sau de probă al SmartBill (documentele
 * emise acolo sunt reale în acel cont). Adaptorul e «încă netestat cu un cont real» până la confirmarea utilizatorului.
 */
export const INVOICING_INTEGRATION_TYPE = "invoicing";

export const INVOICING_CONFIG_CODES = [
  "INVOICING_PROVIDER_UNKNOWN",
  "INVOICING_DEMO_FORBIDDEN",
  "INVOICING_NOT_CONFIGURED",
  "INVOICING_CREDENTIALS_INVALID",
  "INVOICING_LIVE_CONFIRMATION_REQUIRED",
  "INVOICING_LIVE_NOT_VERIFIED",
] as const;

export class InvoicingConfigError extends DomainError {
  constructor(code: (typeof INVOICING_CONFIG_CODES)[number], message: string, details?: unknown) {
    super(code, message, details);
  }
}

export interface InvoicingField {
  key: string;
  label: string;
  required: boolean;
  /** Valoare secretă (nu se afișează niciodată după salvare; câmp de parolă). */
  secret: boolean;
  hint?: string;
}

export interface InvoicingProviderInfo {
  code: InvoiceProviderCode;
  label: string;
  fields: readonly InvoicingField[];
  /** Furnizor real (mod test/LIVE și garda «verificat cu cont real»). */
  real: boolean;
  /** Ce nu e confirmat pentru acest adaptor (afișat în ecran). */
  notes: readonly string[];
}

export const INVOICING_PROVIDERS: Readonly<Record<InvoiceProviderCode, InvoicingProviderInfo>> = {
  smartbill: {
    code: "smartbill",
    label: "SmartBill",
    real: true,
    fields: [
      { key: "email", label: "Email-ul contului SmartBill", required: true, secret: false },
      {
        key: "token",
        label: "Token API",
        required: true,
        secret: true,
        hint: "Din SmartBill Cloud, pagina «Integrări» (Contul meu → Integrări).",
      },
      {
        key: "companyVatCode",
        label: "CIF-ul firmei",
        required: true,
        secret: false,
        hint: "Exact cum e în SmartBill Cloud (cu RO, dacă firma e plătitoare de TVA).",
      },
      {
        key: "invoiceSeries",
        label: "Seria facturilor",
        required: true,
        secret: false,
        hint: "Seria o definești în SmartBill; numărul îl dă SmartBill (aplicația nu numerotează).",
      },
      {
        key: "proformaSeries",
        label: "Seria proformelor",
        required: true,
        secret: false,
        hint: "Folosită la comenzile cu transfer bancar.",
      },
      {
        key: "taxName",
        label: "Numele cotei de TVA din cont",
        required: true,
        secret: false,
        hint: "De exemplu «Normala» (cota de 21%), exact ca în SmartBill Cloud.",
      },
      {
        key: "warehouseName",
        label: "Numele gestiunii pentru descărcare",
        required: false,
        secret: false,
        hint: "Opțional. Fără gestiune, facturile se emit fără descărcare de gestiune; cu litere mari/mici exact ca în cont.",
      },
    ],
    notes: [
      "Încă netestat cu un cont real: construit după specificația OpenAPI publică și verificat doar cu răspunsuri simulate.",
      "SmartBill nu expune statusul e-Factura prin API: starea se vede în contul lor (poți marca manual aici).",
      "Stornoul parțial se emite ca factură cu cantități negative (presupus, nedocumentat); stornoul total e documentat.",
    ],
  },
  demo: {
    code: "demo",
    label: "DEMO (doar dezvoltare)",
    real: false,
    fields: [],
    notes: ["Furnizor simulat: documentele sunt marcate «SIMULAT, nu este document fiscal»."],
  },
};

export const isInvoiceProviderCode = (value: string): value is InvoiceProviderCode =>
  (INVOICE_PROVIDER_CODES as readonly string[]).includes(value);

export function missingInvoicingFields(
  code: InvoiceProviderCode,
  credentials: Readonly<Record<string, string>> | null,
): string[] {
  return INVOICING_PROVIDERS[code].fields
    .filter((field) => field.required && !(credentials?.[field.key] ?? "").trim())
    .map((field) => field.label);
}

export interface InvoicingProviderState {
  code: InvoiceProviderCode;
  label: string;
  real: boolean;
  configured: boolean;
  /** Ce câmpuri au valoare salvată (doar «da/nu», niciodată valoarea). */
  saved: Record<string, boolean>;
  /** Valorile câmpurilor NE-secrete (seria, CIF-ul, numele cotei): se pot afișa în formular. */
  values: Record<string, string>;
  isActive: boolean;
  mode: InvoiceMode;
  verifiedInSandboxAt: Date | null;
  /** E furnizorul ales în `invoicing.provider`. */
  selected: boolean;
  notes: readonly string[];
}

export interface SaveInvoicingInput {
  /** Doar câmpurile completate; cele goale păstrează valoarea salvată. */
  credentials?: Readonly<Record<string, string>>;
  mode?: InvoiceMode;
  isActive?: boolean;
  confirmLive?: boolean;
}

export interface SaveInvoicingResult {
  /** Numele câmpurilor schimbate (NICIODATĂ valorile): pentru jurnalul de audit. */
  changedFields: string[];
  modeBefore: InvoiceMode;
  modeAfter: InvoiceMode;
  activeBefore: boolean;
  activeAfter: boolean;
  revertedToTest: boolean;
  verifiedCleared: boolean;
}

export interface InvoicingConfigDeps {
  db: PrismaClient;
  appKey: string;
  env: DemoGuardEnv;
  now?: () => Date;
  fetch?: FetchLike;
}

interface Row {
  credentials: Record<string, string> | null;
  isActive: boolean;
  mode: InvoiceMode;
  verifiedInSandboxAt: Date | null;
}

const MAX_FIELD = 300;

export class InvoicingConfigService implements InvoiceProviderSource {
  private readonly integrations: IntegrationService;
  private readonly now: () => Date;

  constructor(private readonly deps: InvoicingConfigDeps) {
    this.integrations = new IntegrationService(createPrismaIntegrationStore(deps.db), deps.appKey);
    this.now = deps.now ?? (() => new Date());
  }

  private assertCode(code: string): InvoiceProviderCode {
    if (!isInvoiceProviderCode(code)) {
      throw new InvoicingConfigError(
        "INVOICING_PROVIDER_UNKNOWN",
        "Furnizor de facturare necunoscut",
      );
    }
    if (code === "demo" && !isDemoPaymentAllowed(this.deps.env)) {
      throw new InvoicingConfigError(
        "INVOICING_DEMO_FORBIDDEN",
        "Furnizorul DEMO de facturare nu este disponibil în această instalare",
      );
    }
    return code;
  }

  private async row(code: InvoiceProviderCode): Promise<Row> {
    const found = await this.deps.db.integration.findUnique({
      where: { type_provider: { type: INVOICING_INTEGRATION_TYPE, provider: code } },
    });
    const config = (found?.config ?? {}) as { mode?: unknown };
    return {
      credentials: found?.credentials
        ? await this.integrations.getCredentials(INVOICING_INTEGRATION_TYPE, code)
        : null,
      isActive: found?.isActive ?? false,
      mode: config.mode === "live" ? "live" : "test",
      verifiedInSandboxAt: found?.verifiedInSandboxAt ?? null,
    };
  }

  visibleCodes(): InvoiceProviderCode[] {
    return INVOICE_PROVIDER_CODES.filter(
      (code) => code !== "demo" || isDemoPaymentAllowed(this.deps.env),
    );
  }

  async state(codeInput: string): Promise<InvoicingProviderState> {
    const code = this.assertCode(codeInput);
    const info = INVOICING_PROVIDERS[code];
    const row = await this.row(code);
    return {
      code,
      label: info.label,
      real: info.real,
      configured: !info.real || missingInvoicingFields(code, row.credentials).length === 0,
      saved: Object.fromEntries(
        info.fields.map((field) => [field.key, (row.credentials?.[field.key] ?? "").trim() !== ""]),
      ),
      values: Object.fromEntries(
        info.fields.filter((f) => !f.secret).map((f) => [f.key, row.credentials?.[f.key] ?? ""]),
      ),
      isActive: row.isActive,
      mode: info.real ? row.mode : "test",
      verifiedInSandboxAt: row.verifiedInSandboxAt,
      selected: (await selectedInvoiceProvider(this.deps.db)) === code,
      notes: info.notes,
    };
  }

  list(): Promise<InvoicingProviderState[]> {
    return Promise.all(this.visibleCodes().map((code) => this.state(code)));
  }

  /**
   * Furnizorul pe care îl folosește acum magazinul, sau `null`: ales în setări, activ, complet configurat și, în LIVE, verificat cu un
   * cont real. DEMO doar dacă garda o permite.
   */
  async activeProvider(): Promise<{ code: InvoiceProviderCode; mode: InvoiceMode } | null> {
    const chosen = await selectedInvoiceProvider(this.deps.db);
    if (!chosen) return null;
    if (chosen === "demo") {
      if (!isDemoPaymentAllowed(this.deps.env)) return null;
      const row = await this.row("demo");
      return row.isActive ? { code: "demo", mode: "test" } : null;
    }
    const row = await this.row(chosen);
    if (!row.isActive) return null;
    if (missingInvoicingFields(chosen, row.credentials).length > 0) return null;
    if (row.mode === "live" && !row.verifiedInSandboxAt) return null;
    return { code: chosen, mode: row.mode };
  }

  async active(): Promise<InvoiceProviderCode | null> {
    return (await this.activeProvider())?.code ?? null;
  }

  /**
   * Adaptorul pentru un furnizor (credențiale decriptate, doar pe server), sau `null` dacă nu e configurat. NU cere ca furnizorul să
   * fie activ: PDF-ul și stornarea documentelor deja emise trebuie să funcționeze și după dezactivare. Un furnizor în LIVE
   * neverificat nu se construiește (o garanție în plus față de ecran).
   */
  async provider(codeInput: InvoiceProviderCode): Promise<InvoiceProvider | null> {
    if (!isInvoiceProviderCode(codeInput)) return null;
    if (codeInput === "demo" && !isDemoPaymentAllowed(this.deps.env)) return null;
    const row = await this.row(codeInput);
    if (codeInput !== "demo") {
      if (missingInvoicingFields(codeInput, row.credentials).length > 0) return null;
      if (row.mode === "live" && !row.verifiedInSandboxAt) return null;
    } else if (!row.isActive) {
      return null;
    }
    return buildInvoiceProvider({
      code: codeInput,
      credentials: row.credentials ?? {},
      env: this.deps.env,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      now: this.now,
    });
  }

  async save(codeInput: string, input: SaveInvoicingInput): Promise<SaveInvoicingResult> {
    const code = this.assertCode(codeInput);
    const info = INVOICING_PROVIDERS[code];
    const row = await this.row(code);

    const merged: Record<string, string> = { ...(row.credentials ?? {}) };
    const changedFields: string[] = [];
    for (const field of info.fields) {
      const value = input.credentials?.[field.key]?.trim();
      if (value === undefined || value === "") continue;
      if (value.length > MAX_FIELD) {
        throw new InvoicingConfigError(
          "INVOICING_CREDENTIALS_INVALID",
          `${field.label}: valoare prea lungă`,
        );
      }
      if (merged[field.key] !== value) {
        merged[field.key] = value;
        changedFields.push(field.key);
      }
    }
    if (
      code === "smartbill" &&
      merged["email"] &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged["email"])
    ) {
      throw new InvoicingConfigError(
        "INVOICING_CREDENTIALS_INVALID",
        "Email-ul contului SmartBill nu e valid.",
      );
    }

    const credentialsChanged = changedFields.length > 0;
    let mode: InvoiceMode = info.real ? row.mode : "test";
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
          throw new InvoicingConfigError(
            "INVOICING_LIVE_CONFIRMATION_REQUIRED",
            "Trecerea în LIVE cere confirmare explicită.",
          );
        }
        if (!verified) {
          throw new InvoicingConfigError(
            "INVOICING_LIVE_NOT_VERIFIED",
            "Trecerea în LIVE e refuzată: adaptorul nu a fost încă testat cu un cont real. Rulează verificarea rotunjirii, apoi confirmă testul și încearcă din nou.",
          );
        }
      }
      mode = input.mode;
      changedFields.push("mode");
    }

    const isActive = input.isActive ?? row.isActive;
    if (isActive && info.real && missingInvoicingFields(code, merged).length > 0) {
      throw new InvoicingConfigError(
        "INVOICING_NOT_CONFIGURED",
        `Nu poți activa furnizorul: lipsesc ${missingInvoicingFields(code, merged).join(", ")}.`,
      );
    }
    if (isActive !== row.isActive) changedFields.push("isActive");

    await this.integrations.save({
      type: INVOICING_INTEGRATION_TYPE,
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
    const provider = await this.provider(code);
    if (!provider) {
      const row = await this.row(code);
      const missing = missingInvoicingFields(code, row.credentials);
      return {
        ok: false,
        message: `Date incomplete: lipsesc ${missing.join(", ") || "credențialele"}.`,
      };
    }
    return provider.testConnection();
  }

  /**
   * Marca «testat cu un cont real»: o pune DOAR acțiunea explicită a unui Owner, după ce o conexiune de test a reușit pe
   * credențialele curente. Nu se pune automat de nimic altceva. Fără ea, trecerea în LIVE e refuzată.
   */
  async confirmVerifiedInSandbox(codeInput: string): Promise<{ ok: boolean; message: string }> {
    const code = this.assertCode(codeInput);
    if (!INVOICING_PROVIDERS[code].real) {
      return { ok: false, message: "Furnizorul DEMO nu se verifică cu un cont real." };
    }
    const row = await this.row(code);
    if (missingInvoicingFields(code, row.credentials).length > 0) {
      return { ok: false, message: "Completează mai întâi credențialele." };
    }
    if (row.mode !== "test") return { ok: false, message: "Confirmarea se face în modul test." };
    const test = await this.testConnection(code);
    if (!test.ok) return { ok: false, message: `Conexiunea de test a eșuat: ${test.message}` };
    await this.deps.db.integration.updateMany({
      where: { type: INVOICING_INTEGRATION_TYPE, provider: code },
      data: { verifiedInSandboxAt: this.now() },
    });
    return { ok: true, message: "Testul cu cont real a fost înregistrat." };
  }
}
