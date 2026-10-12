/**
 * Decizia de acces din middleware (Edge). Verifică DOAR dacă există cookie de sesiune: nu are acces
 * la DB sau Redis. Sesiunea reală, expirarea de admin (`auth.adminSessionHours`) și `admin.access`
 * se verifică în layout-ul admin / în `withPermission`; middleware-ul doar scutește de lucru
 * paginile protejate pentru vizitatorii evident neautentificați.
 */

export const LOGIN_PATH = "/autentificare";

/** Antetul (doar intern) prin care middleware-ul dă layout-urilor calea cererii curente. */
export const PATHNAME_HEADER = "x-pathname";

export type GuardDecision =
  { action: "next" } | { action: "redirect"; location: string } | { action: "unauthorized" };

const inSection = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

export const isProtectedPage = (pathname: string): boolean =>
  inSection(pathname, "/admin") || inSection(pathname, "/cont");

export const isProtectedApi = (pathname: string): boolean => inSection(pathname, "/api/admin");

/**
 * Accepță doar o cale relativă din același site pentru `?next=`. Respinge `//host`, `/\host`,
 * scheme (`https:`), caractere de control și buclele către pagina de autentificare.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return null;
  // eslint-disable-next-line no-control-regex -- respingem explicit caracterele de control
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  if (inSection(next.split(/[?#]/)[0] ?? "", LOGIN_PATH)) return null;
  return next;
}

export function guardDecision(input: {
  pathname: string;
  search: string;
  hasSessionCookie: boolean;
}): GuardDecision {
  const { pathname, search, hasSessionCookie } = input;
  if (hasSessionCookie) return { action: "next" };
  if (isProtectedApi(pathname)) return { action: "unauthorized" };
  if (isProtectedPage(pathname)) {
    const next = safeNextPath(pathname + search);
    return {
      action: "redirect",
      location: next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH,
    };
  }
  return { action: "next" };
}
