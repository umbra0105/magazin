import type { PrismaClient } from "@ecom/db";

/**
 * Retenția înregistrărilor de autentificare (Blocul C, C-02). Fără ea, înregistrările în masă cu emailuri inventate lasă
 * în baza de date conturi neverificate și rânduri `verification` expirate, fără sfârșit.
 *
 *  - Conturi: se șterg DOAR cele neverificate, fără niciun rol, mai vechi decât termenul, și DOAR dacă verificarea emailului
 *    e cerută (`auth.requireEmailVerification`): altfel un cont neverificat este un cont obișnuit și nu se atinge. Termenul
 *    efectiv nu e niciodată mai scurt decât valabilitatea linkului de verificare plus 24 de ore.
 *  - `verification`: rândurile expirate de mai mult de o zi.
 * Se șterge în loturi, ca o curățare mare să nu țină tranzacții lungi.
 */

export interface AuthRetentionOptions {
  now?: Date;
  requireEmailVerification: boolean;
  /** Vechimea (zile) după care un cont neverificat se șterge. */
  unverifiedAccountDays: number;
  /** Valabilitatea linkului de verificare (ore): termenul efectiv e cel puțin aceasta plus 24 h. */
  emailVerificationHours: number;
}

export interface AuthRetentionResult {
  users: number;
  verifications: number;
}

const HOUR = 3600 * 1000;
const BATCH = 500;
/** Un rând `verification` expirat de mai puțin de atât se păstrează (diagnostic). */
const VERIFICATION_GRACE_MS = 24 * HOUR;

export async function purgeStaleAuthRecords(
  db: PrismaClient,
  options: AuthRetentionOptions,
): Promise<AuthRetentionResult> {
  const now = options.now ?? new Date();
  let users = 0;

  if (options.requireEmailVerification) {
    const minHours = options.emailVerificationHours + 24;
    const hours = Math.max(options.unverifiedAccountDays * 24, minHours);
    const cutoff = new Date(now.getTime() - hours * HOUR);
    for (;;) {
      const stale = await db.user.findMany({
        where: { emailVerified: false, createdAt: { lt: cutoff }, roles: { none: {} } },
        select: { id: true },
        take: BATCH,
      });
      if (stale.length === 0) break;
      const { count } = await db.user.deleteMany({
        where: { id: { in: stale.map((u) => u.id) }, emailVerified: false, roles: { none: {} } },
      });
      users += count;
      if (stale.length < BATCH) break;
    }
  }

  const expired = await db.verification.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - VERIFICATION_GRACE_MS) } },
  });

  return { users, verifications: expired.count };
}
