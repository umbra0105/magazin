import type { Db } from "../db-tx";
import { enqueueDispatches } from "../email/dispatch";
import { can, hasAdminAccess } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";

/**
 * Alerta pe email «factura nu s-a putut emite» (Faza 13), ca alerta SmartBill din Faza 11. Destinatari: DOAR utilizatorii cu email
 * VERIFICAT și rol cu acces în admin și `invoices.write`; lista se calculează la punerea în coadă, iar eligibilitatea se REVERIFICĂ
 * la fiecare trimitere (`isInvoiceAlertRecipient`, în worker). Se trimite O SINGURĂ DATĂ PE DOCUMENT: cheia evenimentului conține
 * id-ul documentului, iar unicitatea (eveniment, șablon, destinatar) din `email_dispatch` o garantează. Emailul NU conține date
 * personale ale clientului: numărul comenzii, un motiv scurt și linkul din admin.
 */
export const INVOICE_ALERT_TEMPLATE = "internal.invoice_failed";
export const INVOICE_ALERT_PERMISSION = "invoices.write";

async function eligible(db: Db, userId: string): Promise<boolean> {
  const subject = await new PermissionService(db as never).loadSubject(userId);
  return hasAdminAccess(subject) && can(subject, INVOICE_ALERT_PERMISSION);
}

export async function invoiceAlertRecipients(db: Db): Promise<string[]> {
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

export async function isInvoiceAlertRecipient(db: Db, email: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, emailVerified: true },
  });
  if (!user || !user.emailVerified) return false;
  return eligible(db, user.id);
}

/** Pune alerta în coadă (outbox), în tranzacția care a scris notificarea. Întoarce câte rânduri noi s-au scris. */
export async function enqueueInvoiceAlertEmail(
  db: Db,
  alert: { invoiceId: string; orderId: string; reason: string },
): Promise<number> {
  const recipients = await invoiceAlertRecipients(db);
  return enqueueDispatches(
    db,
    recipients.map((recipient) => ({
      template: INVOICE_ALERT_TEMPLATE,
      eventKey: `invoice-failed:${alert.invoiceId}`,
      recipient,
      audience: "internal" as const,
      orderId: alert.orderId,
      data: { reason: alert.reason.slice(0, 160) },
    })),
  );
}
