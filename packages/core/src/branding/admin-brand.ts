import { contrastRatio } from "./contrast";
import { ADMIN_BRAND_REFERENCE } from "./presets";

/**
 * Din `Branding` vin în admin doar culoarea de brand (`accent`, separat pe tema deschisă și pe cea închisă): inelul de focus,
 * legăturile și contoarele (docs/17 §2.4). Restul paletei magazinului nu atinge adminul.
 *
 * Gardă de contrast: brandul se folosește ca legătură pe fundalul paginii (cel puțin 4,5:1; inelul de focus cere doar 3:1,
 * deci e acoperit) și ca fundal pentru textul `--on-brand` al contoarelor (tot 4,5:1). În fișierul de tokeni `--on-brand` are
 * exact culoarea fundalului paginii în fiecare temă (`admin-tokens.test.ts` o verifică), deci o singură verificare, față de
 * pagină, le acoperă pe amândouă. Dacă o temă nu atinge pragul,
 * rezultatul ei e `null`: adminul rămâne pe valoarea lui implicită din fișierul de tokeni. Funcție pură, fără acces la
 * baza de date.
 */
export const ADMIN_BRAND_MIN_CONTRAST = 4.5;

export interface AdminBrandInput {
  light: { accent: string };
  dark: { accent: string };
}

/** `null` = brandul magazinului nu trece garda pe acea temă; adminul folosește valoarea implicită. */
export interface AdminBrand {
  light: string | null;
  dark: string | null;
}

function passes(accent: string, mode: "light" | "dark"): boolean {
  return contrastRatio(accent, ADMIN_BRAND_REFERENCE[mode].page) >= ADMIN_BRAND_MIN_CONTRAST;
}

export function resolveAdminBrand(colors: AdminBrandInput): AdminBrand {
  return {
    light: passes(colors.light.accent, "light") ? colors.light.accent : null,
    dark: passes(colors.dark.accent, "dark") ? colors.dark.accent : null,
  };
}

/** Variabilele CSS puse inline pe suprafața adminului: doar valorile care au trecut garda (culori `#rrggbb` validate de Zod). */
export function adminBrandStyle(brand: AdminBrand): Record<string, string> {
  return {
    ...(brand.light !== null && { "--brand-light": brand.light }),
    ...(brand.dark !== null && { "--brand-dark": brand.dark }),
  };
}
