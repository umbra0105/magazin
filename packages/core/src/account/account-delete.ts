import { inTx, type Db } from "../db-tx";
import { OPEN_RETURN_STATUSES } from "../returns/return-constants";
import { AccountError } from "./account-errors";
import { ownedOrdersWhere, type AccountUser } from "./order-ownership";

/**
 * Ștergerea contului = ANONIMIZAREA lui (decizia 2026-11-22, D4). Comenzile, facturile și `OrderLine.productSnapshot` rămân
 * NESCHIMBATE (obligație fiscală; termenul de păstrare e o setare, de confirmat cu avocatul, INTREBARI-AVOCAT 3.3).
 *
 * Se anonimizează: numele, emailul, telefonul, adresele salvate, wishlist-ul, preferințele; conturile de autentificare (parola) și
 * sesiunile se șterg, deci contul nu se mai poate autentifica. Rândul `user` rămâne (comenzile și retururile îl referă), cu un email
 * de înlocuire care nu mai aparține nimănui. Refuzată cât timp clientul are comenzi nefinalizate (`pending`, `confirmed`,
 * `processing`) sau un retur deschis. Parola o verifică apelantul (acțiunea de server), înaintea acestui apel.
 *
 * Emailul clientului NU se scrie în jurnalul de audit (imuabil): apelantul folosește doar identificatorul intern.
 */
export const UNFINISHED_ORDER_STATUSES = ["pending", "confirmed", "processing"] as const;

export interface DeleteBlockers {
  unfinishedOrders: number;
  openReturns: number;
}

export async function accountDeleteBlockers(db: Db, user: AccountUser): Promise<DeleteBlockers> {
  const [unfinishedOrders, openReturns] = await Promise.all([
    db.order.count({
      where: { AND: [ownedOrdersWhere(user), { status: { in: [...UNFINISHED_ORDER_STATUSES] } }] },
    }),
    db.returnRequest.count({
      where: { userId: user.id, status: { in: [...OPEN_RETURN_STATUSES] } },
    }),
  ]);
  return { unfinishedOrders, openReturns };
}

/** Adresa de înlocuire: nu aparține nimănui (domeniul rezervat `.invalid`). */
export const anonymizedEmail = (userId: string): string => `sters-${userId}@anonimizat.invalid`;

export async function anonymizeAccount(db: Db, user: AccountUser, now: Date): Promise<void> {
  await inTx(db, async (tx) => {
    // blocarea contului: două cereri simultane de ștergere se serializează
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR UPDATE`;
    const fresh = await tx.user.findUnique({
      where: { id: user.id },
      select: { anonymizedAt: true, email: true, emailVerified: true },
    });
    if (!fresh) throw new AccountError("ACCOUNT_PROFILE_INVALID", "Contul nu există");
    if (fresh.anonymizedAt) return; // idempotent
    const current: AccountUser = {
      ...user,
      email: fresh.email,
      emailVerified: fresh.emailVerified,
    };
    if ((await tx.userRole.count({ where: { userId: user.id } })) > 0) {
      // conturile cu rol în administrare nu se șterg din cont (se dezactivează de un administrator)
      throw new AccountError(
        "ACCOUNT_DELETE_BLOCKED",
        "Un cont cu acces în administrare nu se șterge din cont",
        { staff: true },
      );
    }
    const blockers = await accountDeleteBlockers(tx, current);
    if (blockers.unfinishedOrders > 0 || blockers.openReturns > 0) {
      throw new AccountError(
        "ACCOUNT_DELETE_BLOCKED",
        "Contul nu se poate șterge cât ai comenzi nefinalizate sau un retur deschis",
        { ...blockers },
      );
    }
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.account.deleteMany({ where: { userId: user.id } });
    await tx.customerAddress.deleteMany({ where: { userId: user.id } });
    await tx.wishlistItem.deleteMany({ where: { userId: user.id } });
    await tx.customerPreference.deleteMany({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: {
        name: "Cont șters",
        email: anonymizedEmail(user.id),
        emailVerified: false,
        image: null,
        anonymizedAt: now,
      },
    });
  });
}
