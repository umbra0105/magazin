/**
 * Limita de rambursare a rolului Suport (Faza 11, decizia utilizatorului din 2026-11-19).
 *
 * Cum se leagă cele două permisiuni:
 *  - `orders.refund` = poate cere o rambursare din detaliul comenzii;
 *  - `payments.refund` = ecranul și acțiunile de plăți (inclusiv «am rambursat manual») și, pentru rambursare, ÎNLĂTURĂ limita
 *    (Manager, Admin, Owner). Un rol cu `orders.refund` FĂRĂ `payments.refund` (Suport, sau unul creat de magazin) e actor CU
 *    LIMITĂ: suma lui cumulată pe comandă nu poate depăși `payment.supportRefundLimit`.
 *  - Rambursarea cerută de un actor cu limită se marchează pe rând (`Refund.limitedActor`), iar limita se aplică pe suma acestor
 *    rânduri, SUB BLOCAREA comenzii (două cereri simultane nu pot depăși limita împreună). Se numără cererile care țin suma
 *    angajată (cerută, confirmată, manuală); una EȘUATĂ nu mai e angajată.
 *  - Funcția de mai jos e pură: serviciul (`order-refund.ts`) o apelează în tranzacție, iar cine nu trece pe acolo nu poate
 *    rambursa: `requestRefund` din `refund-service` nu verifică limita și e apelat doar de acțiunile cu `payments.refund` și de
 *    serviciul comenzii (un test de arhitectură păzește asta).
 */
export interface RefundLimitInput {
  /** `true` dacă actorul are `payments.refund` (nu are limită). */
  actorUnlimited: boolean;
  /** Limita din setare, în bani; `null` = lipsă sau nelizibilă. */
  limitMinor: number | null;
  /** Suma rambursărilor făcute pe această comandă de actori cu limită (fără cele eșuate). */
  alreadyLimitedMinor: number;
  amountMinor: number;
}

export type RefundLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "limit_unavailable" }
  | { allowed: false; reason: "invalid_amount" }
  | { allowed: false; reason: "over_limit"; remainingMinor: number };

export function decideRefundLimit(input: RefundLimitInput): RefundLimitDecision {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (input.actorUnlimited) return { allowed: true };
  const limit = input.limitMinor;
  if (limit === null || !Number.isSafeInteger(limit) || limit < 0) {
    return { allowed: false, reason: "limit_unavailable" };
  }
  const already = Math.max(0, input.alreadyLimitedMinor);
  const remaining = Math.max(0, limit - already);
  if (input.amountMinor > remaining) {
    return { allowed: false, reason: "over_limit", remainingMinor: remaining };
  }
  return { allowed: true };
}
