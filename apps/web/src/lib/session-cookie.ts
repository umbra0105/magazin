/**
 * Prezența cookie-ului de sesiune Better Auth, pentru middleware (Edge). Citim numele direct, fără
 * `better-auth/cookies`: importul acela aduce `jose` în bundle-ul Edge (avertismente la build).
 *
 * Numele e `<prefix>.<cookie>` (prefix implicit `better-auth`), cu `__Secure-` în față când
 * `useSecureCookies` e activ (producție). Un test de integrare verifică numele față de cel real
 * din instanța Better Auth, pentru ambele variante.
 */
export const SESSION_COOKIE_NAME = "better-auth.session_token";
export const SECURE_COOKIE_PREFIX = "__Secure-";

const NAMES = new Set([SESSION_COOKIE_NAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`]);

/** `true` dacă antetul `Cookie` conține un cookie de sesiune cu valoare nevidă. */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (NAMES.has(name) && part.slice(eq + 1).trim() !== "") return true;
  }
  return false;
}
