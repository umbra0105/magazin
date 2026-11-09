/**
 * Bara laterală pliată la 64 px (docs/17 §3), cu alegerea reținută în `localStorage`. Ca la tema din admin (`theme-choice.ts`),
 * orice acces la stocare e în try/catch, iar pagina funcționează fără ea (bara rămâne desfăcută). Starea trăiește pe <html> ca
 * atribut (`data-admin-sidebar="collapsed"`): scriptul din <head> o pune ÎNAINTE de primul paint (fără un cadru cu bara
 * desfăcută), iar CSS-ul din globals.css reacționează la atribut.
 */
export const SIDEBAR_STORAGE_KEY = "ecom-admin-sidebar";
export const SIDEBAR_ATTRIBUTE = "data-admin-sidebar";

export type SidebarChoice = "expanded" | "collapsed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSidebarChoice(storage: StorageLike | null = defaultStorage()): SidebarChoice {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

/** `false` dacă stocarea nu e disponibilă (alegerea se aplică totuși pe pagina curentă). */
export function writeSidebarChoice(
  choice: SidebarChoice,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SIDEBAR_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** Pune sau scoate atributul de pe <html>; CSS-ul face restul. */
export function applySidebarChoice(choice: SidebarChoice, doc: Document = document): void {
  if (choice === "collapsed") doc.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, "collapsed");
  else doc.documentElement.removeAttribute(SIDEBAR_ATTRIBUTE);
}
