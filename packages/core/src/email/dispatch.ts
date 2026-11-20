import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { emailNoteLabel } from "./note-labels";

/**
 * Emailurile tranzacționale în stil «outbox» (Faza 11). Rândul `EmailDispatch` se scrie în ACEEAȘI tranzacție cu evenimentul care
 * îl declanșează; trimiterea o face workerul, prin coada «emails» (efectele secundare nu rulează niciodată în tranzacție).
 *
 *  - «O singură dată per eveniment» e garantat în bază: unicitatea `(eventKey, template, recipient)` + `INSERT … ON CONFLICT DO
 *    NOTHING` (`skipDuplicates`). Același eveniment procesat de două ori, sau de două workere deodată, dă un singur rând.
 *  - Trimiterea se «revendică» atomic (`queued → sending`); doar cine reușește trimite. O trimitere rămasă `sending` fără
 *    rezultat NU se retrimite automat (risc de email dublu): devine `failed` și se retrimite doar din admin («Retrimite»).
 *  - Erorile se păstrează curățate (fără adresă, token sau corp): `lastError` e doar pentru diagnostic în admin.
 */
export const DISPATCH_STATUSES = ["queued", "sending", "sent", "failed", "skipped"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export interface DispatchInput {
  template: string;
  /** Cheia evenimentului (de obicei `event:<id OrderEvent>`); rămâne aceeași la reprocesare. */
  eventKey: string;
  recipient: string;
  audience: "customer" | "internal";
  orderId?: string;
  /** Doar câmpuri mici și ne-sensibile (motiv, sumă, AWB), niciodată tokenuri sau corpul emailului. */
  data?: Prisma.InputJsonValue;
}

export type DispatchRow = Prisma.EmailDispatchGetPayload<object>;

const MAX_ERROR = 300;
const cleanError = (message: string): string =>
  message.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);

/** Scrie rândurile de trimis, în tranzacția apelantului. Întoarce câte rânduri NOI s-au creat (duplicatele se ignoră). */
export async function enqueueDispatches(tx: Db, inputs: readonly DispatchInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const result = await tx.emailDispatch.createMany({
    data: inputs.map((input) => ({
      template: input.template,
      eventKey: input.eventKey,
      recipient: input.recipient,
      audience: input.audience,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/** `queued → sending`, atomic: doar un apelant primește rândul. `null` = altcineva l-a luat sau nu mai e de trimis. */
export async function claimDispatch(db: Db, id: string, now: Date): Promise<DispatchRow | null> {
  const claimed = await db.emailDispatch.updateMany({
    where: { id, status: "queued" },
    data: { status: "sending", claimedAt: now, attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return null;
  return db.emailDispatch.findUnique({ where: { id } });
}

/** `sending → sent`. Idempotent: un rând deja trimis rămâne neschimbat. */
export async function completeDispatch(db: Db, id: string, now: Date): Promise<void> {
  await db.emailDispatch.updateMany({
    where: { id, status: "sending" },
    data: { status: "sent", sentAt: now, lastError: null },
  });
}

/** Eșec reîncercabil: `sending → queued`, cu eroarea curățată; coada reîncearcă cu backoff. */
export async function releaseDispatch(db: Db, id: string, error: string): Promise<void> {
  await db.emailDispatch.updateMany({
    where: { id, status: "sending" },
    data: { status: "queued", claimedAt: null, lastError: cleanError(error) },
  });
}

/** Eșec definitiv (dead-letter, vizibil în admin): `sending | queued → failed`. */
export async function failDispatch(db: Db, id: string, error: string): Promise<void> {
  const failed = await db.emailDispatch.updateMany({
    where: { id, status: { in: ["sending", "queued"] } },
    data: { status: "failed", lastError: cleanError(error) },
  });
  if (failed.count === 1) {
    const row = await db.emailDispatch.findUnique({
      where: { id },
      select: { template: true, order: { select: { id: true, number: true } } },
    });
    const label = emailNoteLabel(row?.template ?? "");
    // email legat de o comandă: legătura duce la COMANDA (secțiunea ei de emailuri), iar notificarea o văd cei cu dreptul de a o
    // deschide; fără comandă (emailuri interne): jurnalul de emailuri, pentru cei cu `email.read`
    await notifyAdmins(db, {
      kind: "email_failed",
      title: "Un email a rămas netrimis",
      context: row?.order ? orderContext(row.order.number, label) : label,
      href: row?.order
        ? `/admin/comenzi/${row.order.id}`
        : "/admin/comenzi/sabloane-email?vedere=jurnal&filtru=esuate",
      permission: row?.order ? "orders.read" : "email.read",
      dedupKey: `email-failed:${id}`,
    });
  }
}

/** Nimic de trimis (destinatar invalid, comandă dispărută): `queued | sending → skipped`, cu motivul. */
export async function skipDispatch(db: Db, id: string, reason: string): Promise<void> {
  await db.emailDispatch.updateMany({
    where: { id, status: { in: ["queued", "sending"] } },
    data: { status: "skipped", lastError: cleanError(reason) },
  });
}

export interface SweepResult {
  /** Rânduri `queued` mai vechi de `minAgeMs`, de pus în coadă (jobId-ul din coadă deduplică). */
  dueIds: string[];
  /** Trimiteri rămase `sending` fără rezultat: marcate `failed`, NU retrimise automat. */
  staleFailed: number;
}

/** Măturătorul: găsește ce trebuie pus în coadă și curăță trimiterile rămase în aer. */
export async function sweepDispatches(
  db: Db,
  options: { now: Date; minAgeMs: number; staleSendingMs: number; limit: number },
): Promise<SweepResult> {
  const stale = await db.emailDispatch.updateMany({
    where: {
      status: "sending",
      claimedAt: { lte: new Date(options.now.getTime() - options.staleSendingMs) },
    },
    data: {
      status: "failed",
      lastError:
        "Trimiterea nu s-a încheiat (proces oprit): verifică în Mailpit/SMTP înainte de a o retrimite din admin",
    },
  });
  const due = await db.emailDispatch.findMany({
    where: {
      status: "queued",
      createdAt: { lte: new Date(options.now.getTime() - options.minAgeMs) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: options.limit,
    select: { id: true },
  });
  return { dueIds: due.map((row) => row.id), staleFailed: stale.count };
}
