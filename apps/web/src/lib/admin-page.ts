import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { can, type FeatureKey, type PermissionKey, type PermissionSubject } from "@ecom/core";
import { decideAdminAccess, type AdminAccessDecision } from "./admin-access";
import { getFeatureFlags } from "./services";
import { getCurrentResolution } from "./session";

/** Calea cererii curente (setată de middleware), pentru `?next=` la redirecturile de autentificare. */
export async function currentPathname(): Promise<string | null> {
  return (await headers()).get("x-pathname");
}

/** Decizia pentru cererea curentă, fără efecte (layout-ul o folosește ca să randeze „acces interzis”). */
export async function getAdminAccess(): Promise<AdminAccessDecision> {
  return decideAdminAccess(await getCurrentResolution(), await currentPathname());
}

/**
 * Gardă pentru FIECARE pagină de admin (și pentru layout). Layout-urile nu se re-rulează la
 * navigarea în aplicație, iar pagina și layout-ul se randează în paralel: o pagină nu se poate baza
 * pe layout. Redirecționează la autentificare (fără sesiune / sesiune expirată), la `/cont` (fără
 * `admin.access`), la „acces interzis” (fără permisiune) sau dă 404 (funcționalitate oprită).
 */
export async function requireAdmin(
  options: { permission?: PermissionKey; feature?: FeatureKey } = {},
): Promise<PermissionSubject> {
  const decision = await getAdminAccess();
  if (decision.kind === "redirect") redirect(decision.location);
  if (decision.kind === "denied") redirect("/cont");
  if (options.feature && !(await getFeatureFlags().isEnabled(options.feature))) notFound();
  if (options.permission && !can(decision.subject, options.permission)) {
    redirect("/admin/acces-interzis");
  }
  return decision.subject;
}
