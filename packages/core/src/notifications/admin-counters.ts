import type { Db } from "../db-tx";
import { countOrderViews } from "../orders/admin-order-list";
import { paymentCounters } from "../payments/payment-admin";
import type { AdminCounters } from "./admin-notifications";

/**
 * Contoarele din meniul de admin (Faza 11), DOAR cu datele lor: comenzi de procesat, plăți care necesită atenție, notificări de
 * plată blocate, emailuri blocate. Fiecare folosește aceeași condiție ca lista pe care o deschide (un test compară contorul cu
 * lista), cu interogări pe coloane indexate. Aplicația le ține în cache câteva secunde; adevărul rămâne în lista de sub ele.
 */
export async function adminCounters(db: Db, now: Date): Promise<AdminCounters> {
  const [views, payments, emailsFailed] = await Promise.all([
    countOrderViews(db),
    paymentCounters(db, now),
    db.emailDispatch.count({ where: { status: "failed" } }),
  ]);
  return {
    ordersToProcess: views.to_process,
    paymentsAttention: payments.attention,
    stuckEvents: payments.stuckEvents,
    emailsFailed,
  };
}
