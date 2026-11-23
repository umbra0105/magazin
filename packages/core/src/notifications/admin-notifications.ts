import type { Db } from "../db-tx";
import type { PermissionKey } from "../rbac/catalog";

/**
 * Notificările interne ale adminului (Faza 11): înregistrări persistente, FĂRĂ date personale în titlu (doar tipul și o legătură
 * spre ecranul potrivit), vizibile doar celor cu permisiunea notificării (verificată la CITIRE, din permisiunile curente ale
 * utilizatorului), cu citit/necitit PER UTILIZATOR. Se scriu în aceeași tranzacție cu situația care le produce (o plată
 * care intră în «necesită atenție», o rambursare manuală, un email blocat, o sincronizare neactualizată), o singură dată pe
 * situație (`dedupKey` unic: `INSERT … ON CONFLICT DO NOTHING`, deci nici retry-ul și nici două workere nu le dublează).
 */
export const NOTIFICATION_KINDS = [
  "payment_attention",
  "refund_manual",
  "webhook_stuck",
  "email_failed",
  "stock_sync_stale",
  /** O ofertă de plată nu mai poate fi plătită (prețul, transportul, TVA-ul sau stocul s-au schimbat). */
  "offer_stale",
  /** O factură nu s-a putut emite (3 eșecuri, rezultat nesigur sau diferență de sumă): documentul fiscal lipsește sau e de verificat. */
  "invoice_failed",
  /** Un client a cerut un retur (Faza 14): fără date personale, doar numărul comenzii și al returului. */
  "return_requested",
  /** Stornoul parțial al unui retur rambursat nu s-a putut emite sau nu coincide cu rambursarea: verificare fiscală. */
  "return_storno_failed",
  /** Același drept de acces digital e folosit de prea multe adrese IP (Faza 14b): fără date personale, doar numărul comenzii. */
  "digital_ip_anomaly",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NewNotification {
  kind: NotificationKind;
  /** Fără date personale: tipul situației, nu numele sau emailul cuiva. */
  title: string;
  /**
   * Linie scurtă sub titlu, tot fără date personale: numărul comenzii sau al ofertei și un motiv («Comanda WEB-000123 · Plată
   * dublă»). Vezi `orderContext` și `offerContext`.
   */
  context?: string;
  /** Calea ecranului potrivit (începe cu `/admin/`). */
  href: string;
  permission: PermissionKey;
  /** Identifică situația: aceeași cheie nu produce a doua notificare. */
  dedupKey: string;
}

/** Linia de context a unei notificări despre o comandă: «Comanda WEB-000123 · motiv». Numărul comenzii nu e dată personală. */
export const orderContext = (orderNumber: string, what: string): string =>
  `Comanda ${orderNumber} · ${what}`;

/** Linia de context a unei notificări despre o ofertă: «Oferta OF-0066 · motiv» (sau doar numărul). */
export const offerContext = (offerNumber: string, what?: string): string =>
  what ? `Oferta ${offerNumber} · ${what}` : `Oferta ${offerNumber}`;

/** Scrie o notificare, în tranzacția apelantului; întoarce `true` dacă a fost creată (nu exista deja). */
export async function notifyAdmins(tx: Db, input: NewNotification): Promise<boolean> {
  const result = await tx.adminNotification.createMany({
    data: [
      {
        kind: input.kind,
        title: input.title.slice(0, 200),
        ...(input.context ? { context: input.context.slice(0, 200) } : {}),
        href: input.href,
        permission: input.permission,
        dedupKey: input.dedupKey,
      },
    ],
    skipDuplicates: true,
  });
  return result.count === 1;
}

export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  /** Linia de context (număr de comandă sau ofertă și motiv), sau `null` la notificările fără ea. */
  context: string | null;
  href: string;
  createdAt: Date;
  read: boolean;
}

/** Cele mai noi notificări pe care utilizatorul le poate vedea (după permisiunile lui), cu starea citit/necitit a lui. */
export async function listNotifications(
  db: Db,
  user: { userId: string; permissions: ReadonlySet<string> },
  limit = 20,
): Promise<NotificationDto[]> {
  const rows = await db.adminNotification.findMany({
    where: { permission: { in: [...user.permissions] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
    include: { reads: { where: { userId: user.userId }, select: { userId: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    context: row.context,
    href: row.href,
    createdAt: row.createdAt,
    read: row.reads.length > 0,
  }));
}

export async function unreadNotificationCount(
  db: Db,
  user: { userId: string; permissions: ReadonlySet<string> },
): Promise<number> {
  return db.adminNotification.count({
    where: {
      permission: { in: [...user.permissions] },
      reads: { none: { userId: user.userId } },
    },
  });
}

/** Marchează citite (doar pentru acest utilizator) notificările date sau, fără listă, toate cele vizibile lui. Idempotent. */
export async function markNotificationsRead(
  db: Db,
  user: { userId: string; permissions: ReadonlySet<string> },
  ids?: readonly string[],
): Promise<number> {
  const visible = await db.adminNotification.findMany({
    where: {
      permission: { in: [...user.permissions] },
      ...(ids ? { id: { in: [...ids] } } : {}),
      reads: { none: { userId: user.userId } },
    },
    select: { id: true },
    take: 500,
  });
  if (visible.length === 0) return 0;
  const result = await db.adminNotificationRead.createMany({
    data: visible.map((row) => ({ notificationId: row.id, userId: user.userId })),
    skipDuplicates: true,
  });
  return result.count;
}

export interface AdminCounters {
  /** Comenzi confirmate, neexpediate («De procesat»); aceeași condiție ca vederea din listă. */
  ordersToProcess: number;
  /** Plăți cu motiv activ sau rambursări deschise. */
  paymentsAttention: number;
  /** Notificări de plată valide, rămase blocate după toate încercările. */
  stuckEvents: number;
  /** Emailuri blocate definitiv (dead-letter). */
  emailsFailed: number;
}
