import { headers } from "next/headers";
import { PermissionService, createWithPermission, resolveSubject } from "@ecom/core";
import type { SubjectResolution } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAuth, getSettings } from "./services";

/**
 * Utilizatorul curent și motivul dacă lipsește: fără sesiune sau sesiune de admin expirată
 * (`auth.adminSessionHours`). Singurul loc unde sesiunea devine subiect cu permisiuni;
 * îl folosesc layout-ul admin și `withPermission`.
 */
export async function getCurrentResolution(): Promise<SubjectResolution> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  return resolveSubject(
    {
      permissions: new PermissionService(getDb()),
      adminSessionHours: await getSettings().get("auth.adminSessionHours"),
    },
    session ? { userId: session.user.id, createdAt: new Date(session.session.createdAt) } : null,
  );
}

export async function getCurrentSubject() {
  const resolution = await getCurrentResolution();
  return resolution.status === "ok" ? resolution.subject : null;
}

/** Orice server action de admin se împachetează cu asta (testul de arhitectură o impune). */
export const withPermission = createWithPermission({ getSubject: getCurrentSubject });
