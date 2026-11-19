"use server";

import { z } from "zod";
import {
  OrderError,
  PAYMENT_METHODS,
  validateCui,
  verifyCuiForCheckout,
  type LocalityOption,
} from "@ecom/core";
import { DomainError, getLogger, localDateTime } from "@ecom/shared";
import { resolveCartOwner, resolveOwnerForWrite } from "@/lib/cart";
import {
  allowCheckoutRequest,
  anafPort,
  getCheckoutService,
  getGeoService,
  readCheckoutSettings,
  setOrderAccessCookie,
} from "@/lib/checkout";
import { toCheckoutPreviewDto, type CheckoutPreviewDto } from "@/lib/checkout-dto";
import { getCardPayments } from "@/lib/payments";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

/**
 * Acțiunile checkout-ului (Faza 9), apelate din interfață. Fiecare validează intrarea cu Zod, aplică limita de cereri pe IP și
 * lasă serviciile din `@ecom/core` să decidă PE SERVER (livrare, metode de plată, totaluri, plasare). Proprietarul coșului vine
 * din sesiune sau din cookie; clientul nu trimite niciodată id de coș, prețuri sau text juridic. Cardul (Faza 10) se oferă doar cu un furnizor activ.
 */

const m = () => getMessages().storefront.checkout;

const destination = z.object({
  countyCode: z.number().int().positive(),
  localityCode: z.number().int().positive(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

export async function getLocalitiesAction(input: unknown): Promise<LocalityOption[] | null> {
  const parsed = z.number().int().positive().safeParse(input);
  if (!parsed.success) return null;
  if (!(await allowCheckoutRequest("geo"))) return null;
  return getGeoService().localities(parsed.data);
}

export type PreviewActionResult =
  | { ok: true; preview: CheckoutPreviewDto }
  | { ok: false; code: "invalid_input" | "rate_limited" | "failed" };

const previewInput = z.object({
  destination: destination.nullable(),
  offerCode: z.string().min(1).max(100).nullable().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  vatId: z.string().trim().max(20).nullable().optional(),
});

export async function previewCheckoutAction(input: unknown): Promise<PreviewActionResult> {
  const parsed = previewInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  if (!(await allowCheckoutRequest("geo"))) return { ok: false, code: "rate_limited" };
  try {
    const { owner } = await resolveCartOwner();
    const vatId = parsed.data.vatId && validateCui(parsed.data.vatId).ok ? parsed.data.vatId : null;
    const preview = await getCheckoutService().preview({
      owner,
      destination: parsed.data.destination,
      offerCode: parsed.data.offerCode ?? null,
      paymentMethod: parsed.data.paymentMethod ?? null,
      vatId,
    });
    const [format, settings] = await Promise.all([getStorefrontFormat(), readCheckoutSettings()]);
    return {
      ok: true,
      preview: toCheckoutPreviewDto(preview, format, settings, { isCompany: vatId !== null }),
    };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, code: "invalid_input" };
    getLogger().error({ err: error }, "previzualizarea checkout-ului a eșuat");
    return { ok: false, code: "failed" };
  }
}

export type CuiActionResult =
  | { ok: false; reason: "format" | "check_digit" | "rate_limited" }
  | {
      ok: true;
      verification: "verified" | "unverified";
      digits: string;
      company: { name: string; address: string; tradeRegisterNo: string | null } | null;
    };

/** Verifică CUI-ul: local mereu, apoi ANAF (cu timp limită). Un ANAF picat NU blochează: rezultatul e «neverificat». */
export async function lookupCuiAction(input: unknown): Promise<CuiActionResult> {
  const parsed = z.object({ vatId: z.string().trim().min(1).max(20) }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "format" };
  if (!(await allowCheckoutRequest("cui"))) return { ok: false, reason: "rate_limited" };
  const settings = await readCheckoutSettings();
  const l = localDateTime(new Date(), settings.timeZone);
  const today = `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
  const result = await verifyCuiForCheckout(parsed.data.vatId, anafPort, today);
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    verification: result.verification,
    digits: result.digits,
    company: result.company,
  };
}

export type PlaceActionResult =
  | {
      ok: true;
      number: string;
      /** Card: unde merge clientul (pagina procesatorului, sau pagina de plată dacă pornirea a eșuat); altfel lipsește. */
      redirect?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      /** Câmpuri cu probleme (căi din formular), ca interfața să pună focusul pe primul. */
      fields: string[];
      /** Totalul s-a schimbat: interfața reîncarcă previzualizarea. */
      refresh: boolean;
    };

function fail(
  code: string,
  extra: Partial<Extract<PlaceActionResult, { ok: false }>> = {},
): PlaceActionResult {
  const messages: Record<string, string> = m().errors;
  return {
    ok: false,
    code,
    message: messages[code] ?? messages["failed"] ?? "",
    fields: [],
    refresh: false,
    ...extra,
  };
}

/** Plasează comanda. Totalul, livrarea, metoda de plată și textul acordului se verifică din nou pe server. */
export async function placeOrderAction(input: unknown): Promise<PlaceActionResult> {
  if (!(await allowCheckoutRequest("place"))) return fail("rateLimited");
  try {
    const { owner } = await resolveOwnerForWrite();
    const result = await getCheckoutService().place(owner, input);
    await setOrderAccessCookie(result.orderId);
    if (result.paymentId) {
      // card: pornirea plăților se face în afara tranzacției de plasare, cu timp limită; la eșec comanda rămâne în așteptare
      const started = await getCardPayments().initiate(result.paymentId);
      return {
        ok: true,
        number: result.number,
        redirect:
          started.kind === "redirect"
            ? started.redirect.url
            : `/comanda/plata/${encodeURIComponent(result.paymentId)}`,
      };
    }
    return { ok: true, number: result.number };
  } catch (error) {
    if (error instanceof DomainError) {
      const issues = (error.details as { issues?: Array<{ path: string }> } | undefined)?.issues;
      const refresh =
        error instanceof OrderError &&
        [
          "ORDER_TOTAL_CHANGED",
          "ORDER_CART_CHANGED",
          "ORDER_OFFER_UNAVAILABLE",
          "ORDER_PAYMENT_METHOD_UNAVAILABLE",
        ].includes(error.code);
      return fail(error.code, { fields: issues?.map((issue) => issue.path) ?? [], refresh });
    }
    getLogger().error({ err: error }, "plasarea comenzii a eșuat");
    return fail("failed");
  }
}
