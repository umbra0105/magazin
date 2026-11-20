import type { Db } from "../db-tx";
import { can, hasAdminAccess } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { enqueueDispatches } from "./dispatch";

/**
 * Alerta pe email «sincronizarea SmartBill e neactualizată» (Faza 11, pasul 7). Destinatari: DOAR utilizatorii cu email VERIFICAT
 * și rol cu acces în admin și `inventory.write` («activ» = are rolul care îi dă accesul; conturile nu au alt comutator de
 * dezactivare, iar fără rol nu intră în admin). Lista se calculează la punerea în coadă, iar eligibilitatea se REVERIFICĂ la fiecare
 * trimitere (`isStockAlertRecipient`, în worker): un rol retras sau un email schimbat între timp scoate destinatarul.
 * Se trimite O SINGURĂ DATĂ PE EPISOD: cheia evenimentului conține depozitul și momentul alertei de trecere (nu al memento-ului),
 * iar unicitatea (eveniment, șablon, destinatar) din `email_dispatch` o garantează și la rulări repetate.
 */
export const STOCK_SYNC_ALERT_TEMPLATE = "internal.stock_sync_stale";
export const STOCK_SYNC_ALERT_PERMISSION = "inventory.write";

async function eligible(db: Db, userId: string): Promise<boolean> {
  const subject = await new PermissionService(db as never).loadSubject(userId);
  return hasAdminAccess(subject) && can(subject, STOCK_SYNC_ALERT_PERMISSION);
}

/** Adresele (minuscule) cărora le merge alerta acum. */
export async function stockAlertRecipients(db: Db): Promise<string[]> {
  const candidates = await db.user.findMany({
    where: { emailVerified: true, roles: { some: {} } },
    orderBy: [{ email: "asc" }, { id: "asc" }],
    select: { id: true, email: true },
  });
  const result: string[] = [];
  for (const candidate of candidates) {
    if (await eligible(db, candidate.id)) result.push(candidate.email.trim().toLowerCase());
  }
  return result;
}

/** Reverificarea de la trimitere: adresa aparține încă unui utilizator verificat, cu acces în admin și `inventory.write`. */
export async function isStockAlertRecipient(db: Db, email: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, emailVerified: true },
  });
  if (!user || !user.emailVerified) return false;
  return eligible(db, user.id);
}

/** Pune alerta în coadă (outbox), în tranzacția care a scris alerta de trecere. Întoarce câte rânduri noi s-au scris. */
export async function enqueueStockSyncAlert(
  db: Db,
  episode: { warehouseId: string; alertedAt: Date; takenAt: Date | null },
): Promise<number> {
  const recipients = await stockAlertRecipients(db);
  return enqueueDispatches(
    db,
    recipients.map((recipient) => ({
      template: STOCK_SYNC_ALERT_TEMPLATE,
      eventKey: `stock-sync:${episode.warehouseId}:${episode.alertedAt.toISOString()}`,
      recipient,
      audience: "internal" as const,
      data: { takenAt: episode.takenAt ? episode.takenAt.toISOString() : null },
    })),
  );
}
