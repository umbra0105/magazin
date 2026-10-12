/**
 * Alegerea temei în admin: Sistem / Luminos / Întunecat, păstrată în `localStorage`. Orice acces la
 * stocare (inclusiv obținerea lui `window.localStorage`) poate arunca — mod privat, cookie-uri
 * blocate, iframe sandbox — deci totul e în try/catch, iar pagina funcționează corect fără stocare.
 *
 * Mecanismul: două foi de stil cu paleta luminoasă și cea întunecată (`/theme-light.css`,
 * `/theme-dark.css`), a căror atribut `media` se comută:
 *   sistem  → light: "not all",  dark: "(prefers-color-scheme: dark)"
 *   luminos → light: "all",      dark: "not all"
 *   întunecat → light: "not all", dark: "all"
 * Ambele vin DUPĂ `/theme.css`, deci câștigă la aceeași specificitate.
 */

export const THEME_STORAGE_KEY = "ecom-admin-theme";
export const THEME_LIGHT_LINK_ID = "admin-theme-light";
export const THEME_DARK_LINK_ID = "admin-theme-dark";

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

export const MEDIA_FOR_CHOICE: Record<ThemeChoice, { light: string; dark: string }> = {
  system: { light: "not all", dark: "(prefers-color-scheme: dark)" },
  light: { light: "all", dark: "not all" },
  dark: { light: "not all", dark: "all" },
};

/** Aplică alegerea pe documentul curent (comută `media` pe cele două foi de stil). */
export function applyThemeChoice(choice: ThemeChoice, doc: Document = document): void {
  const media = MEDIA_FOR_CHOICE[choice];
  const light = doc.getElementById(THEME_LIGHT_LINK_ID);
  const dark = doc.getElementById(THEME_DARK_LINK_ID);
  light?.setAttribute("media", media.light);
  dark?.setAttribute("media", media.dark);
  try {
    doc.documentElement.style.colorScheme = choice === "system" ? "" : choice;
  } catch {
    // stilul nu e esențial
  }
}

/**
 * Script inline pus în layout-ul de admin, înainte de conținut: aplică alegerea salvată înainte de
 * primul paint (fără flash). Autonom: nu depinde de bundle. Totul în try/catch.
 */
export const THEME_INIT_SCRIPT =
  `(function(){try{var c=null;try{c=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}` +
  `if(c!=="light"&&c!=="dark")return;` +
  `var l=document.getElementById(${JSON.stringify(THEME_LIGHT_LINK_ID)}),d=document.getElementById(${JSON.stringify(THEME_DARK_LINK_ID)});` +
  `if(l)l.setAttribute("media",c==="light"?"all":"not all");` +
  `if(d)d.setAttribute("media",c==="dark"?"all":"not all");` +
  `document.documentElement.style.colorScheme=c;}catch(e){}})();`;
