"use server";

import { z } from "zod";
import { OfferError } from "@ecom/core";
import { DomainError, ValidationError, getLogger } from "@ecom/shared";
import { allowCheckoutRequest, setOrderAccessCookie } from "@/lib/checkout";
import { getOfferService } from "@/lib/offers";
import { getCardPayments } from "@/lib/payments";

/**
 * «Plătește» din pagina unei oferte (Faza 11). Clientul trimite DOAR jetonul din adresă și bifa Termenilor; adresa, produsele,
 * prețurile, transportul și metoda de plată (cardul) vin din oferta înghețată, pe server. Limita de cereri pe IP e verificată
 * întâi; un jeton necunoscut, expirat, anulat sau «stale» dă același cod («unavailable»).
 */
export type PayOfferResult =
  | { ok: true; redirect: string }
  | { ok: false; code: "consent" | "unavailable" | "cardUnavailable" | "rateLimited" | "failed" };

const input = z.object({
  token: z.string().min(1).max(100),
  consent: z.object({ accepted: z.boolean(), version: z.string().max(50) }),
});

export async function payOfferAction(raw: unknown): Promise<PayOfferResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "unavailable" };
  if (!(await allowCheckoutRequest("offerPay"))) return { ok: false, code: "rateLimited" };
  try {
    const result = await getOfferService().convert(parsed.data.token, parsed.data.consent);
    await setOrderAccessCookie(result.orderId);
    if (!result.paymentId) return { ok: true, redirect: "/comanda/urmarire" };
    const page = `/comanda/plata/${encodeURIComponent(result.paymentId)}`;
    // a doua plată pe același link: comanda există deja, clientul continuă de pe pagina ei de plată (cu «Reîncearcă plata»)
    if (result.replayed) return { ok: true, redirect: page };
    const started = await getCardPayments().initiate(result.paymentId);
    return { ok: true, redirect: started.kind === "redirect" ? started.redirect.url : page };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, code: "consent" };
    if (error instanceof OfferError) {
      if (error.code === "OFFER_CARD_UNAVAILABLE") return { ok: false, code: "cardUnavailable" };
      return { ok: false, code: "unavailable" };
    }
    if (error instanceof DomainError) return { ok: false, code: "unavailable" };
    getLogger().error({ err: error }, "plata ofertei a eșuat");
    return { ok: false, code: "failed" };
  }
}
