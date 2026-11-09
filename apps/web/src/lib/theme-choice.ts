import { SIDEBAR_ATTRIBUTE, SIDEBAR_STORAGE_KEY } from "./sidebar-choice";

/**
 * Alegerea temei în admin: Sistem / Luminos / Întunecat, păstrată în `localStorage`. Orice acces la
 * stocare (inclusiv obținerea lui `window.localStorage`) poate arunca — mod privat, cookie-uri
 * blocate, iframe sandbox — deci totul e în try/catch, iar pagina funcționează corect fără stocare.
 *
 * Mecanismul: tokenii adminului (`packages/ui/src/styles/admin-tokens.css`) au valorile ambelor teme în
 * `light-dark(deschis, închis)`, iar tema activă e `color-scheme` de pe <html>:
 *   sistem    → neatins (CSS-ul pune `color-scheme: light dark`: browserul urmează sistemul)
 *   luminos   → `color-scheme: light`
 *   întunecat → `color-scheme: dark`
 * Paleta magazinului din `Branding` nu mai intră în admin (docs/17 §2.4); foile `/theme-light.css` și `/theme-dark.css`
 * nu mai sunt încărcate aici.
 */

export const THEME_STORAGE_KEY = "ecom-admin-theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readThemeChoice(storage: StorageLike | null = defaultStorage()): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** `false` dacă stocarea nu e disponibilă (alegerea se aplică totuși pe pagina curentă). */
export function writeThemeChoice(
  choice: ThemeChoice,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** Aplică alegerea pe documentul curent: `color-scheme` pe <html> (sistem îl curăță). */
export function applyThemeChoice(choice: ThemeChoice, doc: Document = document): void {
  try {
    doc.documentElement.style.colorScheme = choice === "system" ? "" : choice;
  } catch {
    // stilul nu e esențial
  }
}

/**
 * Script inline pus în layout-ul de admin, înaintea conținutului (blochează randarea: nu există un cadru cu tema greșită): aplică tema și starea barei laterale salvate
 * înainte de primul paint (fără flash). Autonom: nu depinde de bundle. Fiecare citire e în propriul try/catch, ca o alegere
 * ilizibilă să n-o împiedice pe cealaltă. Singura injectare de HTML brut permisă în aplicație, alături de `RichText` (testul `description-writes` o păzește).
 */
export const THEME_INIT_SCRIPT =
  `(function(){var s=null;try{s=window.localStorage}catch(e){}if(!s)return;` +
  `try{var c=s.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(c==="light"||c==="dark")document.documentElement.style.colorScheme=c}catch(e){}` +
  `try{if(s.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)})==="collapsed")` +
  `document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_ATTRIBUTE)},"collapsed")}catch(e){}})();`;
