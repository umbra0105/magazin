import { ValidationError } from "@ecom/shared";
import {
  INTEGRATION_CREDENTIALS_KEY_LABEL,
  decrypt,
  deriveKey,
  encrypt,
  maskSecret,
} from "../crypto";

export type IntegrationCredentials = Record<string, string>;

export interface IntegrationRecord {
  type: string;
  provider: string;
  /** Valoare criptată `v1:...` sau null dacă nu are credențiale. */
  credentials: string | null;
  config: unknown;
  isActive: boolean;
}

/** Ce îi trebuie serviciului din baza de date (satisfăcut de Prisma și de fake-uri de test). */
export interface IntegrationStore {
  find(type: string, provider: string): Promise<IntegrationRecord | null>;
  upsert(record: IntegrationRecord): Promise<void>;
}

/** Ce poate vedea UI-ul și API-ul: credențialele sunt DOAR mascate. */
export interface IntegrationPublicView {
  type: string;
  provider: string;
  config: unknown;
  isActive: boolean;
  credentials: Record<string, string>;
}

export interface SaveIntegrationInput {
  type: string;
  provider: string;
  /** Înlocuiește integral credențialele existente. Omis = rămân cele stocate. */
  credentials?: IntegrationCredentials;
  config?: unknown;
  isActive?: boolean;
}

export class IntegrationService {
  private readonly key: Buffer;

  constructor(
    private readonly store: IntegrationStore,
    appKey: string,
  ) {
    this.key = deriveKey(appKey, INTEGRATION_CREDENTIALS_KEY_LABEL);
  }

  async save(input: SaveIntegrationInput): Promise<void> {
    const existing = await this.store.find(input.type, input.provider);
    const credentials = input.credentials
      ? encrypt(JSON.stringify(input.credentials), this.key)
      : (existing?.credentials ?? null);
    await this.store.upsert({
      type: input.type,
      provider: input.provider,
      credentials,
      config: input.config ?? existing?.config ?? {},
      isActive: input.isActive ?? existing?.isActive ?? false,
    });
  }

  /** Credențiale în clar. DOAR pentru adaptoare, pe server; niciodată spre UI, API sau loguri. */
  async getCredentials(type: string, provider: string): Promise<IntegrationCredentials | null> {
    const record = await this.store.find(type, provider);
    if (!record?.credentials) return null;
    const parsed: unknown = JSON.parse(decrypt(record.credentials, this.key));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("Credențiale stocate într-un format neașteptat", {
        type,
        provider,
      });
    }
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  }

  /** Varianta sigură pentru afișare: fiecare credențială apare ca `****abcd`. */
  async getPublicView(type: string, provider: string): Promise<IntegrationPublicView | null> {
    const record = await this.store.find(type, provider);
    if (!record) return null;
    const credentials = await this.getCredentials(type, provider);
    return {
      type: record.type,
      provider: record.provider,
      config: record.config,
      isActive: record.isActive,
      credentials: Object.fromEntries(
        Object.entries(credentials ?? {}).map(([k, v]) => [k, maskSecret(v)]),
      ),
    };
  }
}
