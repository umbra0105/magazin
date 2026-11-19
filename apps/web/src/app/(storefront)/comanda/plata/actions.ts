"use server";

import { z } from "zod";
import { errorCodeOf } from "@/lib/error-code";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { allowCheckoutRequest, readOrderAccess } from "@/lib/checkout";
import { toPaymentStateDto, type PaymentStateDto } from "@/lib/card-payment-view";
import { getCardPayments } from "@/lib/payments";
import { getSettings } from "@/lib/services";

/**
 * Acțiunile paginilor de plată cu cardul (Faza 10). Pagina de retur NU confirmă nimic: citește doar starea din baza noastră,
 * actualizată de notificările procesatorului (webhook), iar accesul vine din cookie-ul semnat de la plasare (ID-ul plății din adresă
 * nu dă acces fără el: fără IDOR). «Reîncearcă plata» e limitat pe IP și creează o tentativă nouă doar dacă stocul există.
 */
export type PollResult =
  { ok: true; view: PaymentStateDto } | { ok: false; code: "forbidden" | "rate_limited" };

const idSchema = z.string().min(8).max(64);

/** Comanda e a celui care a plasat-o (cookie semnat) și plata ei e a acestei comenzi. */
async function ownedOrderId(paymentId: string): Promise<string | null> {
  const orderId = await readOrderAccess();
  if (!orderId) return null;
  const payment = await getDb().payment.findUnique({
    where: { id: paymentId },
    select: { orderId: true },
  });
  return payment && payment.orderId === orderId ? orderId : null;
}

export async function pollCardPaymentAction(input: unknown): Promise<PollResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "forbidden" };
  if (!(await allowCheckoutRequest("pay"))) return { ok: false, code: "rate_limited" };
  const orderId = await ownedOrderId(parsed.data);
  if (!orderId) return { ok: false, code: "forbidden" };
  const view = await getCardPayments().stateOfOrder(orderId);
  if (!view) return { ok: false, code: "forbidden" };
  const regional = await getSettings().getGroup("regional");
  return { ok: true, view: toPaymentStateDto(view, regional) };
}

export type RetryResult =
  | { ok: true; redirect: string }
  | {
      ok: false;
      code: "forbidden" | "rate_limited" | "no_stock" | "expired" | "unavailable" | "failed";
    };

function describe(error: unknown): RetryResult {
  const code = errorCodeOf(error, ["PAYMENT_"]);
  if (code === "PAYMENT_RETRY_NO_STOCK") return { ok: false, code: "no_stock" };
  if (code === "PAYMENT_RETRY_EXPIRED") return { ok: false, code: "expired" };
  if (code === "PAYMENT_CARD_UNAVAILABLE") return { ok: false, code: "unavailable" };
  if (code === "PAYMENT_RETRY_UNAVAILABLE") return { ok: false, code: "expired" };
  getLogger().error({ err: error }, "reîncercarea plății a eșuat");
  return { ok: false, code: "failed" };
}

/** Tentativă nouă pornită dintr-un jeton valid: rezervă stocul (doar dacă există) și trimite clientul la procesator. */
async function startAndRedirect(token: string): Promise<RetryResult> {
  const cards = getCardPayments();
  try {
    const started = await cards.startRetry(token);
    const result = await cards.initiate(started.paymentId);
    return {
      ok: true,
      redirect:
        result.kind === "redirect"
          ? result.redirect.url
          : `/comanda/plata/${encodeURIComponent(started.paymentId)}`,
    };
  } catch (error) {
    return describe(error);
  }
}

/** «Reîncearcă plata» din pagina de așteptare (cookie-ul comenzii dă accesul; jetonul se emite pe loc). */
export async function retryCardPaymentAction(input: unknown): Promise<RetryResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "forbidden" };
  if (!(await allowCheckoutRequest("payRetry"))) return { ok: false, code: "rate_limited" };
  const orderId = await ownedOrderId(parsed.data);
  if (!orderId) return { ok: false, code: "forbidden" };
  try {
    const { token } = await getCardPayments().issueRetryToken(orderId);
    return await startAndRedirect(token);
  } catch (error) {
    return describe(error);
  }
}

/** Linkul «reîncearcă plata» (jeton aleatoriu din adresă, valabil 24 h). */
export async function payByLinkAction(input: unknown): Promise<RetryResult> {
  const parsed = z.string().min(20).max(100).safeParse(input);
  if (!parsed.success) return { ok: false, code: "forbidden" };
  if (!(await allowCheckoutRequest("payRetry"))) return { ok: false, code: "rate_limited" };
  return startAndRedirect(parsed.data);
}
