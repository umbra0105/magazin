import type { Db } from "../db-tx";
import { notifyAdmins, offerContext } from "../notifications/admin-notifications";

/**
 * Ce îi trebuie workerului ca să trimită linkul unei oferte (Faza 11): numărul, totalul, termenul și numele clientului se citesc
 * din baza de date în momentul trimiterii, nu din coadă (în coadă stau doar id-ul ofertei, adresa și jetonul, sigilate).
 */
export interface OfferEmailSource {
  number: string;
  status: string;
  expiresAt: Date;
  totalMinor: number;
  tokenHash: string;
  clientName: string;
}

export async function loadOfferForEmail(db: Db, offerId: string): Promise<OfferEmailSource | null> {
  const offer = await db.orderOffer.findUnique({
    where: { id: offerId },
    select: {
      number: true,
      status: true,
      expiresAt: true,
      totalMinor: true,
      tokenHash: true,
      shipping: true,
    },
  });
  if (!offer) return null;
  const shipping = offer.shipping as { fullName?: unknown } | null;
  return {
    number: offer.number,
    status: offer.status,
    expiresAt: offer.expiresAt,
    totalMinor: offer.totalMinor,
    tokenHash: offer.tokenHash,
    clientName: typeof shipping?.fullName === "string" ? shipping.fullName : "",
  };
}

/**
 * Trimiterea linkului a eșuat definitiv (toate încercările): eveniment pe ofertă și notificare în admin, o dată pe trimitere
 * (`sendKey` = id-ul jobului). Fără adresă și fără jeton în text.
 */
export async function recordOfferEmailFailure(
  db: Db,
  offerId: string,
  sendKey: string,
  reason: string,
): Promise<void> {
  const offer = await db.orderOffer.findUnique({
    where: { id: offerId },
    select: { number: true },
  });
  if (!offer) return;
  await db.orderOfferEvent.create({
    data: {
      offerId,
      type: "offer.email_failed",
      message: "Emailul cu linkul nu a putut fi trimis",
      data: { reason: reason.slice(0, 300) },
    },
  });
  await notifyAdmins(db, {
    kind: "email_failed",
    title: "Emailul cu linkul unei oferte nu a putut fi trimis",
    context: offerContext(offer.number),
    href: `/admin/comenzi/oferte/${offerId}`,
    permission: "orders.offers",
    dedupKey: `offer_email_failed:${offerId}:${sendKey}`,
  });
}
