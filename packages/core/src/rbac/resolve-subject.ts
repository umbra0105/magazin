import { isAdminSessionExpired } from "../auth/session-policy";
import { hasAdminAccess, type PermissionSubject } from "./can";
import type { PermissionService } from "./permission-service";

export type SubjectResolution =
  | { status: "ok"; subject: PermissionSubject }
  | { status: "no-session" }
  | { status: "admin-session-expired" };

export interface ResolveSubjectDeps {
  permissions: Pick<PermissionService, "loadSubject">;
  adminSessionHours: number;
  now?: Date;
}

/**
 * Din sesiune în utilizator cu permisiuni. O sesiune a unui cont cu acces în admin, mai veche decât
 * `adminSessionHours`, e refuzată (`admin-session-expired`): layout-ul face redirect la
 * autentificare, iar `withPermission` o tratează ca neautentificat. Clienții nu sunt afectați.
 */
export async function resolveSubject(
  deps: ResolveSubjectDeps,
  session: { userId: string; createdAt: Date } | null,
): Promise<SubjectResolution> {
  if (!session) return { status: "no-session" };
  const subject = await deps.permissions.loadSubject(session.userId);
  if (!subject) return { status: "no-session" };
  if (
    hasAdminAccess(subject) &&
    isAdminSessionExpired(session.createdAt, deps.adminSessionHours, deps.now)
  ) {
    return { status: "admin-session-expired" };
  }
  return { status: "ok", subject };
}
