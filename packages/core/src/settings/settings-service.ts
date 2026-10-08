import { ValidationError, getLogger } from "@ecom/shared";
import {
  getSettingSchema,
  listSettingKeys,
  settingGroups,
  type SettingGroupName,
  type SettingGroupValue,
  type SettingKey,
  type SettingValue,
} from "./registry";

/** Ce îi trebuie serviciului din baza de date (satisfăcut de Prisma și de fake-uri de test). */
export interface SettingsStore {
  loadAll(): Promise<{ key: string; value: unknown }[]>;
  upsert(row: { key: string; group: string; value: unknown }): Promise<void>;
}

/** Ce îi trebuie serviciului de la Redis (satisfăcut de ioredis). */
export interface SettingsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const SETTINGS_CACHE_KEY = "ecom:settings:v1";
export const SETTINGS_CACHE_TTL_SECONDS = 300;

export interface CompanyInfo {
  storeName: string;
  legalName: string;
  vatId: string;
  tradeRegisterNo: string;
  isVatPayer: boolean;
  address: SettingValue<"company.address">;
  email: string;
  phone: string;
  iban: string;
  bankName: string;
}

export class SettingsService {
  constructor(
    private readonly store: SettingsStore,
    private readonly cache: SettingsCache,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return this.parseStored(key, await this.loadMap()) as SettingValue<K>;
  }

  async getGroup<G extends SettingGroupName>(group: G): Promise<SettingGroupValue<G>> {
    const map = await this.loadMap();
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(settingGroups[group])) {
      out[name] = this.parseStored(`${group}.${name}`, map);
    }
    return out as SettingGroupValue<G>;
  }

  /** Validează, scrie și invalidează cache-ul. `auditLog()` se leagă la nivelul server action-ului. */
  async set<K extends SettingKey>(key: K, value: unknown): Promise<SettingValue<K>> {
    const schema = getSettingSchema(key);
    if (!schema) throw new ValidationError(`Setare necunoscută: ${key}`, { key });
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(`Valoare invalidă pentru setarea ${key}`, {
        key,
        issues: parsed.error.issues,
      });
    }
    const group = key.split(".")[0] as string;
    await this.store.upsert({ key, group, value: parsed.data });
    await this.invalidate();
    return parsed.data as SettingValue<K>;
  }

  /** Datele firmei, într-un singur loc: footer, facturi, emailuri, pagini legale. */
  async getCompanyInfo(): Promise<CompanyInfo> {
    const [general, company] = await Promise.all([
      this.getGroup("general"),
      this.getGroup("company"),
    ]);
    return {
      storeName: general.storeName,
      legalName: company.legalName,
      vatId: company.vatId,
      tradeRegisterNo: company.tradeRegisterNo,
      isVatPayer: company.isVatPayer,
      address: company.address,
      email: company.email,
      phone: company.phone,
      iban: company.iban,
      bankName: company.bankName,
    };
  }

  async invalidate(): Promise<void> {
    try {
      await this.cache.del(SETTINGS_CACHE_KEY);
    } catch (error) {
      getLogger().warn({ err: error }, "invalidarea cache-ului de setări a eșuat");
    }
  }

  /**
   * Valoarea stocată se validează la citire și lipsa ei dă valoarea implicită din schemă.
   * Una coruptă NU se înlocuiește pe tăcute cu default (o cotă de TVA greșită ar ajunge pe facturi).
   */
  private parseStored(key: string, map: Record<string, unknown>): unknown {
    const schema = getSettingSchema(key);
    if (!schema) throw new ValidationError(`Setare necunoscută: ${key}`, { key });
    const parsed = schema.safeParse(map[key]);
    if (!parsed.success) {
      throw new ValidationError(`Valoare invalidă în baza de date pentru setarea ${key}`, {
        key,
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  /** Harta `cheie → valoare stocată`, din Redis; la lipsă sau Redis picat, din DB. */
  private async loadMap(): Promise<Record<string, unknown>> {
    try {
      const cached = await this.cache.get(SETTINGS_CACHE_KEY);
      if (cached) return JSON.parse(cached) as Record<string, unknown>;
    } catch (error) {
      getLogger().warn({ err: error }, "citirea cache-ului de setări a eșuat, citesc din DB");
    }
    const rows = await this.store.loadAll();
    const known = new Set<string>(listSettingKeys().map((k) => k.key));
    const map: Record<string, unknown> = {};
    for (const row of rows) if (known.has(row.key)) map[row.key] = row.value;
    try {
      await this.cache.set(
        SETTINGS_CACHE_KEY,
        JSON.stringify(map),
        "EX",
        SETTINGS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      getLogger().warn({ err: error }, "scrierea cache-ului de setări a eșuat");
    }
    return map;
  }
}
