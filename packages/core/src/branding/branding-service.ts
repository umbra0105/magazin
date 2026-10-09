import { ValidationError, getLogger } from "@ecom/shared";
import { invalidateCache, readThrough, type KeyValueCache } from "../cache/read-through";
import { checkContrast, type ContrastWarning } from "./contrast";
import { renderThemeCss, themeEtag } from "./css";
import { DEFAULT_PRESET, configFromPreset } from "./presets";
import { brandingConfigSchema, type BrandingConfig } from "./tokens";

/** Rândul din tabela `Branding` (un singur rând). Câmpurile Json sunt validate la citire. */
export interface BrandingRow {
  preset: string;
  colors: unknown;
  fonts: unknown;
  radius: string;
  darkMode: boolean;
  logoUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
}

export interface BrandingStore {
  load(): Promise<BrandingRow | null>;
  save(row: BrandingRow): Promise<void>;
}

export const BRANDING_CACHE_KEY = "ecom:branding:v1";
export const BRANDING_CACHE_TTL_SECONDS = 300;

export interface SaveBrandingResult {
  config: BrandingConfig;
  /** Perechi text/fundal sub WCAG AA. Doar avertisment: salvarea nu se blochează. */
  warnings: ContrastWarning[];
}

export class BrandingService {
  constructor(
    private readonly store: BrandingStore,
    private readonly cache: KeyValueCache,
  ) {}

  /** Configurația validată. Fără rând sau cu date invalide în DB: presetul implicit (nu blochează site-ul). */
  async getConfig(): Promise<BrandingConfig> {
    const row = await readThrough<BrandingRow | null>({
      cache: this.cache,
      key: BRANDING_CACHE_KEY,
      ttlSeconds: BRANDING_CACHE_TTL_SECONDS,
      label: "branding",
      load: () => this.store.load(),
    });
    if (!row) return configFromPreset(DEFAULT_PRESET);
    const parsed = brandingConfigSchema.safeParse(row);
    if (!parsed.success) {
      getLogger().error(
        { issues: parsed.error.issues },
        "Branding invalid în baza de date, folosesc presetul implicit",
      );
      return configFromPreset(DEFAULT_PRESET);
    }
    return parsed.data;
  }

  /** CSS-ul temei și ETag-ul lui, pentru `/theme.css`. */
  async getTheme(): Promise<{ css: string; etag: string }> {
    const css = renderThemeCss(await this.getConfig());
    return { css, etag: themeEtag(css) };
  }

  /** Validează strict, scrie, invalidează cache-ul și întoarce avertismentele de contrast. */
  async save(input: unknown): Promise<SaveBrandingResult> {
    const parsed = brandingConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Branding invalid", { issues: parsed.error.issues });
    }
    const config = parsed.data;
    await this.store.save({
      preset: config.preset,
      colors: config.colors,
      fonts: config.fonts,
      radius: config.radius,
      darkMode: config.darkMode,
      logoUrl: config.logoUrl,
      faviconUrl: config.faviconUrl,
      ogImageUrl: config.ogImageUrl,
    });
    await this.invalidate();
    return { config, warnings: checkContrast(config) };
  }

  async invalidate(): Promise<void> {
    await invalidateCache(this.cache, BRANDING_CACHE_KEY, "branding");
  }
}
