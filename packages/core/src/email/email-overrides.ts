import type { Db } from "../db-tx";

/**
 * Suprascrierile șabloanelor de email (Faza 11): doar subiectul și textul de început, per șablon. Validarea (variabilele permise
 * ale șablonului, lungimile) o face apelantul cu `validateOverride` din pachetul de emailuri, ÎNAINTE de salvare; aici doar se
 * păstrează. Ștergerea rândului = revenire la textul implicit. Auditul din admin îl scrie acțiunea.
 */
export interface EmailOverrideDto {
  template: string;
  subject: string;
  intro: string;
  updatedBy: string;
  updatedAt: Date;
}

export async function getEmailOverride(db: Db, template: string): Promise<EmailOverrideDto | null> {
  return db.emailTemplateOverride.findUnique({ where: { template } });
}

export async function listEmailOverrides(db: Db): Promise<EmailOverrideDto[]> {
  return db.emailTemplateOverride.findMany({ orderBy: { template: "asc" } });
}

export async function saveEmailOverride(
  db: Db,
  input: { template: string; subject: string; intro: string; updatedBy: string },
): Promise<void> {
  const subject = input.subject.trim();
  const intro = input.intro.trim();
  await db.emailTemplateOverride.upsert({
    where: { template: input.template },
    create: { template: input.template, subject, intro, updatedBy: input.updatedBy },
    update: { subject, intro, updatedBy: input.updatedBy },
  });
}

export async function deleteEmailOverride(db: Db, template: string): Promise<boolean> {
  const removed = await db.emailTemplateOverride.deleteMany({ where: { template } });
  return removed.count === 1;
}

/** Jurnalul de trimiteri pentru admin: cele mai noi primele, cu ordine deterministă; fără corpul emailului. */
export interface EmailLogRow {
  id: string;
  template: string;
  audience: string;
  recipient: string;
  status: string;
  attempts: number;
  lastError: string | null;
  orderId: string | null;
  orderNumber: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export type EmailLogView = "all" | "failed" | "queued";

export async function listEmailLog(
  db: Db,
  options: { view: EmailLogView; page: number; pageSize: number },
): Promise<{ rows: EmailLogRow[]; total: number; failed: number }> {
  const where =
    options.view === "failed"
      ? { status: "failed" }
      : options.view === "queued"
        ? { status: { in: ["queued", "sending"] } }
        : {};
  const pageSize = Math.min(Math.max(options.pageSize, 5), 100);
  const page = Math.max(1, Math.trunc(options.page));
  const [total, failed, rows] = await Promise.all([
    db.emailDispatch.count({ where }),
    db.emailDispatch.count({ where: { status: "failed" } }),
    db.emailDispatch.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { order: { select: { number: true } } },
    }),
  ]);
  return {
    total,
    failed,
    rows: rows.map((row) => ({
      id: row.id,
      template: row.template,
      audience: row.audience,
      recipient: row.recipient,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      orderId: row.orderId,
      orderNumber: row.order?.number ?? null,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    })),
  };
}
