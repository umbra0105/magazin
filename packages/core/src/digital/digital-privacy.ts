import type { Db } from "../db-tx";
import { readDigitalSettings } from "./digital-settings";

/**
 * Datele personale ale produselor digitale (Faza 14b, decizia 9):
 *  - `DigitalAccessLog` ține IP și user-agent DOAR cât cere funcția (setarea `digital.accessLogRetentionDays`, de confirmat cu
 *    avocatul, INTREBARI-AVOCAT 3.5); după termen devin nule, iar rândul (fără date personale) rămâne;
 *  - la ștergerea contului (anonimizare, Faza 14) IP-ul și user-agent-ul din jurnalul clientului devin nule IMEDIAT;
 *  - exportul GDPR include achizițiile digitale și accesările proprii (momentul, acțiunea, modulul), fără cheie de stocare, fără
 *    jeton de acces, fără IP și user-agent (ca restul exportului) și fără secrete.
 */

/** Anulează IP-ul și user-agent-ul din tot jurnalul clientului; întoarce câte rânduri au fost curățate. */
export async function anonymizeAccessLogs(db: Db, userId: string): Promise<number> {
  const result = await db.digitalAccessLog.updateMany({
    where: {
      entitlement: { customerId: userId },
      OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ip: null, userAgent: null },
  });
  return result.count;
}

/** Termenul de păstrare: curăță IP-ul și user-agent-ul rândurilor mai vechi decât setarea. Întoarce numărul de rânduri curățate. */
export async function purgeExpiredAccessLogData(db: Db, now: Date): Promise<number> {
  const settings = await readDigitalSettings(db);
  const cutoff = new Date(now.getTime() - settings.accessLogRetentionDays * 86_400_000);
  const result = await db.digitalAccessLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ip: null, userAgent: null },
  });
  return result.count;
}

export interface DigitalExport {
  purchases: Array<{
    orderNumber: string;
    product: string;
    grantedAt: string;
    status: "activ" | "retras";
    revokedAt: string | null;
    revokedReason: string | null;
    downloads: number;
    downloadLimit: number | null;
    accesses: Array<{ at: string; action: "vizionare" | "descărcare"; module: string | null }>;
  }>;
}

/** Achizițiile digitale și accesările proprii ale clientului, pentru exportul GDPR (lista albă de câmpuri). */
export async function buildDigitalExport(db: Db, userId: string): Promise<DigitalExport> {
  const rows = await db.digitalEntitlement.findMany({
    where: { customerId: userId },
    orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
    select: {
      grantedAt: true,
      revokedAt: true,
      revokedReason: true,
      downloadCount: true,
      maxDownloads: true,
      order: { select: { number: true } },
      product: { select: { title: true } },
      accessLogs: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, action: true, asset: { select: { title: true } } },
      },
    },
  });
  return {
    purchases: rows.map((row) => ({
      orderNumber: row.order.number,
      product: row.product.title,
      grantedAt: row.grantedAt.toISOString(),
      status: row.revokedAt ? "retras" : "activ",
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedReason: row.revokedReason,
      downloads: row.downloadCount,
      downloadLimit: row.maxDownloads,
      accesses: row.accessLogs.map((log) => ({
        at: log.createdAt.toISOString(),
        action: log.action === "download" ? "descărcare" : "vizionare",
        module: log.asset?.title ?? null,
      })),
    })),
  };
}
