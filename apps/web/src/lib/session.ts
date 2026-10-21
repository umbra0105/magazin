import { headers } from "next/headers";
import {
  DeniedAuditGate,
  PermissionService,
  createWithPermission,
  recordDeniedAttempt,
  recordDeniedThrottled,
  resolveClientIp,
  resolveSubject,
} from "@ecom/core";
import type { SubjectResolution } from "@ecom/core";
import { getDb } from "@ecom/db";
import { REQUEST_ID_HEADER } from "@ecom/shared/request-id";
import { getAudit } from "./admin-writes";
import { getAuth, getCounterStore, getSettings } from "./services";

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

/**
 * Orice server action de admin se împachetează cu asta (testul de arhitectură o impune).
 *  - verifică permisiunea pe server, la fiecare apel;
 *  - o încercare refuzată NU rulează acțiunea și se înregistrează în jurnal cu rezultatul
 *    `denied` (actor, acțiunea încercată, permisiunea lipsă; NICIODATĂ datele trimise);
 *  - handlerul rulează în contextul `requestId`-ului cererii (apare în jurnalul de audit).
 */
export const withPermission = createWithPermission({
  getSubject: getCurrentSubject,
  getRequestId: async () => (await headers()).get(REQUEST_ID_HEADER),
  // Refuzul se aplică mereu; DOAR scrierea în audit (tabelă care nu se poate șterge) e limitată: C-08.
  onDenied: async (attempt) => {
    const hops = await getSettings().get("auth.trustedProxyHops");
    const ip = resolveClientIp(await headers(), hops);
    const decision = await new DeniedAuditGate(getCounterStore()).decide({
      actorId: attempt.subject?.userId ?? null,
      ip,
    });
    if (decision === "record") await recordDeniedAttempt(getAudit(), attempt);
    else if (decision === "summary") await recordDeniedThrottled(getAudit(), attempt);
  },
});
