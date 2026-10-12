import type { PermissionSubject, SubjectResolution } from "@ecom/core";
import { hasAdminAccess } from "@ecom/core";
import { LOGIN_PATH, safeNextPath } from "./route-guard";

/** Valoarea parametrului `?sesiune=` care face pagina de autentificare să spună „Sesiunea a expirat”. */
export const SESSION_EXPIRED_PARAM = "expirata";

export type AdminAccessDecision =
  | { kind: "allow"; subject: PermissionSubject }
  | { kind: "redirect"; location: string; reason: "no-session" | "session-expired" }
  | { kind: "denied"; reason: "no-admin-access" };

/**
 * Decizia de acces în zona de admin, dintr-o rezolvare de sesiune (vezi `resolveSubject`):
 *  - fără sesiune → autentificare (cu `?next=`);
 *  - sesiune de admin mai veche decât `auth.adminSessionHours` → autentificare, cu mesajul
 *    „Sesiunea a expirat”;
 *  - fără `admin.access` (client, sau rol fără această permisiune) → refuz;
 *  - altfel acces.
 * `pathname` (cu query) devine `?next=` doar dacă trece de `safeNextPath`, ca la middleware.
 */
export function decideAdminAccess(
  resolution: SubjectResolution,
  pathname: string | null,
): AdminAccessDecision {
  const next = safeNextPath(pathname);
  const nextParam = next ? `next=${encodeURIComponent(next)}` : "";
  const login = (query: string[]) => {
    const parts = query.filter(Boolean);
    return parts.length > 0 ? `${LOGIN_PATH}?${parts.join("&")}` : LOGIN_PATH;
  };

  if (resolution.status === "no-session") {
    return { kind: "redirect", reason: "no-session", location: login([nextParam]) };
  }
  if (resolution.status === "admin-session-expired") {
    return {
      kind: "redirect",
      reason: "session-expired",
      location: login([`sesiune=${SESSION_EXPIRED_PARAM}`, nextParam]),
    };
  }
  if (!hasAdminAccess(resolution.subject)) {
    return { kind: "denied", reason: "no-admin-access" };
  }
  return { kind: "allow", subject: resolution.subject };
}
