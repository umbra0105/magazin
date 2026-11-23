import type { PrismaClient } from "@ecom/db";
import {
  MEDIA_DELIVERY_DRIVER_CODES,
  type ConnectionTestResult,
  type MediaDeliveryDriverCode,
  type MediaDeliveryProvider,
} from "@ecom/shared";
import { buildMediaDelivery, type FetchLike, type StorageDriver } from "@ecom/integrations";
import { IntegrationService } from "../integrations/integration-service";
import { createPrismaIntegrationStore } from "../integrations/prisma-store";
import { DigitalError } from "./digital-errors";

/**
 * Configurarea livrării conținutului digital (Faza 14b), peste `IntegrationService` (credențiale criptate AES-256-GCM, tipul
 * «digital_delivery»), cu garanțiile din plăți, curieri și facturare:
 *  - `local` nu cere cont și e mereu disponibil (stocarea platformei, pentru dezvoltare);
 *  - `bunny` și `s3` sunt ÎNCĂ NETESTATE CU UN CONT REAL: se pot folosi doar după ce un Owner a salvat cheile ȘI a confirmat explicit
 *    «am testat cu un cont real» (`verifiedInSandboxAt`); fără confirmare, serverul refuză activarea și nu construiește driverul;
 *  - schimbarea cheilor șterge confirmarea și dezactivează furnizorul;
 *  - credențialele nu se întorc niciodată spre interfață: starea publică spune doar ce câmpuri sunt salvate.
 */
export const DIGITAL_INTEGRATION_TYPE = "digital_delivery";

export type RealDeliveryCode = "bunny" | "s3";
export const REAL_DELIVERY_CODES: readonly RealDeliveryCode[] = ["bunny", "s3"];

export interface DeliveryField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  hint?: string;
}

export interface DeliveryInfo {
  code: RealDeliveryCode;
  label: string;
  /** Ce conținut livrează. */
  serves: "video" | "file";
  fields: readonly DeliveryField[];
  notes: readonly string[];
}

export const DELIVERY_PROVIDERS: Readonly<Record<RealDeliveryCode, DeliveryInfo>> = {
  bunny: {
    code: "bunny",
    label: "Bunny Stream (video)",
    serves: "video",
    fields: [
      { key: "apiKey", label: "Cheie API a bibliotecii", required: true, secret: true },
      {
        key: "libraryId",
        label: "ID bibliotecă video",
        required: true,
        secret: false,
        hint: "Numărul bibliotecii din contul Bunny Stream.",
      },
      {
        key: "tokenAuthKey",
        label: "Cheie de autentificare a tokenului",
        required: true,
        secret: true,
        hint: "Din setările de securitate ale bibliotecii (autentificare prin token pentru embed).",
      },
    ],
    notes: [
      "Încă netestat cu un cont real: construit după documentația publică și verificat doar cu răspunsuri simulate.",
      "De verificat într-un cont real: căile API, codurile de stare ale transcodării, formula tokenului de embed și filigranul cu emailul cumpărătorului (presupus).",
    ],
  },
  s3: {
    code: "s3",
    label: "S3 (fișiere)",
    serves: "file",
    fields: [
      { key: "endpoint", label: "Adresa serviciului S3 (endpoint)", required: true, secret: false },
      { key: "region", label: "Regiunea", required: false, secret: false },
      { key: "bucket", label: "Numele bucket-ului", required: true, secret: false },
      { key: "accessKeyId", label: "ID cheie de acces", required: true, secret: false },
      { key: "secretAccessKey", label: "Cheie secretă", required: true, secret: true },
    ],
    notes: [
      "Încă netestat cu un cont real de producție: verificat doar cu un spațiu de stocare simulat.",
      "Bucket-ul trebuie să fie PRIVAT: fișierele se livrează doar prin linkuri presemnate cu expirare scurtă.",
    ],
  },
};

export const isRealDeliveryCode = (value: string): value is RealDeliveryCode =>
  (REAL_DELIVERY_CODES as readonly string[]).includes(value);

export const isDeliveryCode = (value: string): value is MediaDeliveryDriverCode =>
  (MEDIA_DELIVERY_DRIVER_CODES as readonly string[]).includes(value);

export function missingDeliveryFields(
  code: RealDeliveryCode,
  credentials: Readonly<Record<string, string>> | null,
): string[] {
  return DELIVERY_PROVIDERS[code].fields
    .filter((field) => field.required && !(credentials?.[field.key] ?? "").trim())
    .map((field) => field.label);
}

export interface DeliveryState {
  code: RealDeliveryCode;
  label: string;
  serves: "video" | "file";
  configured: boolean;
  /** Ce câmpuri au valoare salvată (doar «da/nu», niciodată valoarea). */
  saved: Record<string, boolean>;
  isActive: boolean;
  verifiedInSandboxAt: Date | null;
  notes: readonly string[];
}

export interface SaveDeliveryResult {
  changedFields: string[];
  verifiedCleared: boolean;
  deactivated: boolean;
}

export interface DeliveryConfigDeps {
  db: PrismaClient;
  appKey: string;
  appUrl: string;
  /** Stocarea platformei (driverul `local`). */
  platformStorage: StorageDriver;
  fetch?: FetchLike;
  now?: () => Date;
  /** Doar teste: stocarea simulată a driverului `s3` (fără cont real). */
  s3Storage?: StorageDriver;
}

interface Row {
  credentials: Record<string, string> | null;
  isActive: boolean;
  verifiedInSandboxAt: Date | null;
}

const MAX_FIELD = 2000;

export class DeliveryConfigService {
  private readonly integrations: IntegrationService;
  private readonly now: () => Date;

  constructor(private readonly deps: DeliveryConfigDeps) {
    this.integrations = new IntegrationService(createPrismaIntegrationStore(deps.db), deps.appKey);
    this.now = deps.now ?? (() => new Date());
  }

  private assertReal(code: string): RealDeliveryCode {
    if (!isRealDeliveryCode(code)) {
      throw new DigitalError("DIGITAL_CONFIG_INVALID", "Furnizor de livrare necunoscut");
    }
    return code;
  }

  private async row(code: RealDeliveryCode): Promise<Row> {
    const found = await this.deps.db.integration.findUnique({
      where: { type_provider: { type: DIGITAL_INTEGRATION_TYPE, provider: code } },
    });
    return {
      credentials: found?.credentials
        ? await this.integrations.getCredentials(DIGITAL_INTEGRATION_TYPE, code)
        : null,
      isActive: found?.isActive ?? false,
      verifiedInSandboxAt: found?.verifiedInSandboxAt ?? null,
    };
  }

  async state(codeInput: string): Promise<DeliveryState> {
    const code = this.assertReal(codeInput);
    const info = DELIVERY_PROVIDERS[code];
    const row = await this.row(code);
    return {
      code,
      label: info.label,
      serves: info.serves,
      configured: missingDeliveryFields(code, row.credentials).length === 0,
      saved: Object.fromEntries(
        info.fields.map((field) => [field.key, (row.credentials?.[field.key] ?? "").trim() !== ""]),
      ),
      isActive: row.isActive,
      verifiedInSandboxAt: row.verifiedInSandboxAt,
      notes: info.notes,
    };
  }

  list(): Promise<DeliveryState[]> {
    return Promise.all(REAL_DELIVERY_CODES.map((code) => this.state(code)));
  }

  /** Salvează doar câmpurile completate (cele goale păstrează valoarea salvată). Orice schimbare șterge confirmarea și dezactivează. */
  async save(
    codeInput: string,
    credentials: Readonly<Record<string, string>>,
  ): Promise<SaveDeliveryResult> {
    const code = this.assertReal(codeInput);
    const info = DELIVERY_PROVIDERS[code];
    const row = await this.row(code);
    const merged: Record<string, string> = { ...(row.credentials ?? {}) };
    const changedFields: string[] = [];
    for (const field of info.fields) {
      const value = credentials[field.key]?.trim();
      if (value === undefined || value === "") continue;
      if (value.length > MAX_FIELD) {
        throw new DigitalError("DIGITAL_CONFIG_INVALID", `${field.label}: valoare prea lungă`);
      }
      if (merged[field.key] !== value) {
        merged[field.key] = value;
        changedFields.push(field.key);
      }
    }
    if (code === "bunny" && merged["libraryId"] && !/^\d{1,12}$/.test(merged["libraryId"])) {
      throw new DigitalError(
        "DIGITAL_CONFIG_INVALID",
        "ID-ul bibliotecii Bunny trebuie să fie un număr.",
      );
    }
    if (code === "s3" && merged["endpoint"] && !/^https?:\/\//.test(merged["endpoint"])) {
      throw new DigitalError(
        "DIGITAL_CONFIG_INVALID",
        "Adresa serviciului S3 trebuie să înceapă cu https://",
      );
    }
    if (changedFields.length === 0) {
      return { changedFields, verifiedCleared: false, deactivated: false };
    }
    const verifiedCleared = row.verifiedInSandboxAt !== null;
    const deactivated = row.isActive;
    await this.integrations.save({
      type: DIGITAL_INTEGRATION_TYPE,
      provider: code,
      credentials: merged,
      isActive: false,
      verifiedInSandboxAt: null,
    });
    return { changedFields, verifiedCleared, deactivated };
  }

  /** Testul de conexiune cu cheile salvate (nu confirmă nimic: doar spune dacă furnizorul răspunde). */
  async testConnection(codeInput: string): Promise<ConnectionTestResult> {
    const code = this.assertReal(codeInput);
    const row = await this.row(code);
    if (missingDeliveryFields(code, row.credentials).length > 0) {
      return { ok: false, message: "Completează mai întâi cheile." };
    }
    try {
      return await this.build(code, row.credentials ?? {}).testConnection();
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Conexiunea a eșuat.",
      };
    }
  }

  /**
   * «Confirm că am testat cu un cont real»: pune marca `verifiedInSandboxAt`. Doar cu cheile complete; apelantul (acțiunea de server)
   * cere `digital.configure` (Owner) și o bifă explicită.
   */
  async confirmVerified(codeInput: string): Promise<void> {
    const code = this.assertReal(codeInput);
    const row = await this.row(code);
    if (missingDeliveryFields(code, row.credentials).length > 0) {
      throw new DigitalError(
        "DIGITAL_CONFIG_INVALID",
        "Completează toate cheile înainte să confirmi testul cu un cont real.",
      );
    }
    await this.integrations.save({
      type: DIGITAL_INTEGRATION_TYPE,
      provider: code,
      verifiedInSandboxAt: this.now(),
    });
  }

  /** Activare/dezactivare. Activarea cere chei complete ȘI confirmarea lui Owner; altfel `DIGITAL_LIVE_NOT_VERIFIED`. */
  async setActive(codeInput: string, active: boolean): Promise<void> {
    const code = this.assertReal(codeInput);
    const row = await this.row(code);
    if (active) {
      if (missingDeliveryFields(code, row.credentials).length > 0) {
        throw new DigitalError(
          "DIGITAL_CONFIG_INVALID",
          "Completează toate cheile înainte să activezi furnizorul.",
        );
      }
      if (!row.verifiedInSandboxAt) {
        throw new DigitalError(
          "DIGITAL_LIVE_NOT_VERIFIED",
          "Furnizorul nu poate fi activat până nu confirmi (ca Owner) că l-ai testat cu un cont real.",
        );
      }
    }
    await this.integrations.save({
      type: DIGITAL_INTEGRATION_TYPE,
      provider: code,
      isActive: active,
    });
  }

  private build(
    code: MediaDeliveryDriverCode,
    credentials: Readonly<Record<string, string>>,
  ): MediaDeliveryProvider {
    return buildMediaDelivery({
      code,
      platformStorage: this.deps.platformStorage,
      credentials,
      appUrl: this.deps.appUrl,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.s3Storage ? { s3Storage: this.deps.s3Storage } : {}),
    });
  }

  /**
   * Driverul unui cod, pentru LIVRARE și pentru încărcare. `local` mereu. `bunny` și `s3` DOAR dacă sunt active, complete și
   * confirmate de Owner: altfel `DIGITAL_PROVIDER_UNAVAILABLE` (gardă pe server, nu doar în ecran).
   */
  async provider(codeInput: string): Promise<MediaDeliveryProvider> {
    if (!isDeliveryCode(codeInput)) {
      throw new DigitalError("DIGITAL_PROVIDER_UNAVAILABLE", "Furnizor de livrare necunoscut");
    }
    if (codeInput === "local") return this.build("local", {});
    const row = await this.row(codeInput);
    if (
      !row.isActive ||
      !row.verifiedInSandboxAt ||
      missingDeliveryFields(codeInput, row.credentials).length > 0
    ) {
      throw new DigitalError(
        "DIGITAL_PROVIDER_UNAVAILABLE",
        "Furnizorul de livrare nu este activ: contactează administratorul magazinului",
      );
    }
    return this.build(codeInput, row.credentials ?? {});
  }
}
