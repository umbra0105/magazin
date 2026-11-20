"use server";

import { z } from "zod";
import {
  buildOfferLink,
  searchOfferVariants,
  type OfferPreview,
  type OfferVariantOption,
  type LocalityOption,
  type CountyOption,
} from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { getGeoService } from "@/lib/checkout";
import { queueOfferLink } from "@/lib/email";
import { errorCodeOf } from "@/lib/error-code";
import { getOfferService } from "@/lib/offers";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului pe ofertele de plată (Faza 11). Toate cer `orders.offers`, verificat pe server la fiecare apel. Intrarea e
 * validată cu Zod aici și din nou în `OfferService`; prețurile, transportul și stocul vin DOAR din motorul de prețuri și din
 * serviciul de livrare (interfața nu trimite nicio sumă). Auditul înregistrează numărul ofertei și totalul, niciodată adresa,
 * telefonul, emailul sau jetonul. Jetonul din link se întoarce o singură dată (la creare și la retrimitere), nu se păstrează.
 */
type FailCode =
  | "invalid"
  | "validation"
  | "digital"
  | "notPayable"
  | "cardUnavailable"
  | "stock"
  | "state"
  | "notFound"
  | "failed";
type Fail = { ok: false; code: FailCode; fields?: string[] };

const KNOWN: Record<string, FailCode> = {
  OFFER_INVALID: "invalid",
  OFFER_DIGITAL_NOT_SUPPORTED: "digital",
  OFFER_NOT_PAYABLE: "notPayable",
  OFFER_CARD_UNAVAILABLE: "cardUnavailable",
  OFFER_STATE_INVALID: "state",
  OFFER_NOT_FOUND: "notFound",
  VALIDATION_ERROR: "validation",
};

function failure(error: unknown): Fail {
  const code = errorCodeOf(error, ["OFFER_", "CART_", "VALIDATION_", "ORDER_", "GEO_"]);
  if (code?.startsWith("CART_")) return { ok: false, code: "stock" };
  const mapped = code ? KNOWN[code] : undefined;
  if (mapped === "validation") {
    const issues = (error as { details?: { issues?: Array<{ path: string }> } }).details?.issues;
    return { ok: false, code: "validation", fields: issues?.map((issue) => issue.path) ?? [] };
  }
  return { ok: false, code: mapped ?? "failed" };
}

const id = z.string().min(1).max(64);

const lineSchema = z.object({
  variantId: z.string().min(1).max(40),
  quantity: z.string().min(1).max(24),
});
const destinationSchema = z.object({
  countyCode: z.number().int().positive(),
  localityCode: z.number().int().positive(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

const audit = (
  subject: { userId: string; email: string },
  action: string,
  offerId: string,
  after: Record<string, unknown>,
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "order_offer",
    entityId: offerId,
    after,
  });

// --- căutări pentru ecranul de creare (doar citire) -------------------------------------------------------------------

export const searchOfferProductsAction = withPermission(
  "orders.offers",
  async (raw: unknown): Promise<OfferVariantOption[]> => {
    const parsed = z.strictObject({ query: z.string().max(80) }).safeParse(raw);
    if (!parsed.success) return [];
    return searchOfferVariants(getDb(), parsed.data.query);
  },
  { action: "offer.search", entity: "order_offer" },
);

export const listOfferCountiesAction = withPermission(
  "orders.offers",
  async (): Promise<CountyOption[]> => getGeoService().counties(),
  { action: "offer.counties", entity: "order_offer" },
);

export const listOfferLocalitiesAction = withPermission(
  "orders.offers",
  async (raw: unknown): Promise<LocalityOption[]> => {
    const parsed = z.strictObject({ countyCode: z.number().int().positive() }).safeParse(raw);
    return parsed.success ? getGeoService().localities(parsed.data.countyCode) : [];
  },
  { action: "offer.localities", entity: "order_offer" },
);

// --- previzualizare ---------------------------------------------------------------------------------------------------

export type PreviewOfferResult = { ok: true; preview: OfferPreview } | Fail;

export const previewOfferAction = withPermission(
  "orders.offers",
  async (raw: unknown): Promise<PreviewOfferResult> => {
    const parsed = z
      .strictObject({
        lines: z.array(lineSchema).min(1).max(50),
        destination: destinationSchema,
        shippingOfferCode: z.string().min(1).max(100).nullable().optional(),
        vatId: z.string().trim().max(20).nullable().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const preview = await getOfferService().preview({
        lines: parsed.data.lines,
        destination: parsed.data.destination,
        shippingOfferCode: parsed.data.shippingOfferCode ?? null,
        vatId: parsed.data.vatId ?? null,
      });
      return { ok: true, preview };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "offer.preview", entity: "order_offer" },
);

// --- creare -----------------------------------------------------------------------------------------------------------

export type CreateOfferResult =
  | {
      ok: true;
      offerId: string;
      number: string;
      /** Linkul complet: se arată o singură dată, nu se mai poate citi ulterior. */
      link: string;
      emailQueued: boolean | null;
    }
  | Fail;

export const createOfferAction = withPermission(
  "orders.offers",
  async (raw: unknown, subject): Promise<CreateOfferResult> => {
    const parsed = z.strictObject({ draft: z.unknown(), sendEmail: z.boolean() }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const offers = getOfferService();
      const created = await offers.create(parsed.data.draft as never, {
        id: subject.userId,
        label: subject.email,
      });
      let emailQueued: boolean | null = null;
      if (parsed.data.sendEmail) {
        const row = await getDb().orderOffer.findUniqueOrThrow({
          where: { id: created.offerId },
          select: { email: true },
        });
        emailQueued = await queueOfferLink({
          offerId: created.offerId,
          to: row.email,
          token: created.token,
        });
        if (emailQueued) {
          await offers.recordSend(created.offerId, { id: subject.userId, label: subject.email });
        }
      }
      await audit(subject, "offer.create", created.offerId, {
        number: created.number,
        totalMinor: created.totals.totalMinor,
        emailQueued,
      });
      return {
        ok: true,
        offerId: created.offerId,
        number: created.number,
        link: buildOfferLink(loadEnv().APP_URL, created.token),
        emailQueued,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "offer.create", entity: "order_offer" },
);

// --- retrimitere (jeton nou) ------------------------------------------------------------------------------------------

export type ReissueOfferResult = { ok: true; link: string; emailQueued: boolean | null } | Fail;

export const reissueOfferAction = withPermission(
  "orders.offers",
  async (raw: unknown, subject): Promise<ReissueOfferResult> => {
    const parsed = z.strictObject({ offerId: id, sendEmail: z.boolean() }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const offers = getOfferService();
      const actor = { id: subject.userId, label: subject.email };
      const issued = await offers.reissueToken(parsed.data.offerId, actor);
      let emailQueued: boolean | null = null;
      if (parsed.data.sendEmail) {
        const row = await getDb().orderOffer.findUniqueOrThrow({
          where: { id: parsed.data.offerId },
          select: { email: true },
        });
        emailQueued = await queueOfferLink({
          offerId: parsed.data.offerId,
          to: row.email,
          token: issued.token,
        });
        if (emailQueued) await offers.recordSend(parsed.data.offerId, actor);
      }
      await audit(subject, "offer.reissue", parsed.data.offerId, { emailQueued });
      return {
        ok: true,
        link: buildOfferLink(loadEnv().APP_URL, issued.token),
        emailQueued,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "offer.reissue", entity: "order_offer" },
);

// --- prima trimitere pe email --------------------------------------------------------------------------------------------

export type SendOfferResult = { ok: true; link: string; emailQueued: boolean } | Fail;

/**
 * «Trimite linkul» (oferta nu a plecat încă pe email): generează un link nou (cel din creare, dacă a fost copiat, nu mai merge) și
 * îl trimite pe emailul clientului. Aceleași reguli ca la retrimitere: jetonul din bază se schimbă o singură dată (prima trimitere
 * se «revendică» atomic, deci un dublu-click sau doi admini nu produc două emailuri cu linkuri diferite), emailul trece prin aceeași
 * coadă (un singur rând de trimitere per eveniment), iar auditul înregistrează trimiterea fără adresă sau jeton. Dacă emailul nu poate
 * fi pus în coadă, prima trimitere se eliberează și adminul poate încerca din nou.
 */
export const sendOfferAction = withPermission(
  "orders.offers",
  async (raw: unknown, subject): Promise<SendOfferResult> => {
    const parsed = z.strictObject({ offerId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const offers = getOfferService();
    const actor = { id: subject.userId, label: subject.email };
    try {
      const issued = await offers.reissueToken(parsed.data.offerId, actor, { firstSendOnly: true });
      let emailQueued = false;
      try {
        const row = await getDb().orderOffer.findUniqueOrThrow({
          where: { id: parsed.data.offerId },
          select: { email: true },
        });
        emailQueued = await queueOfferLink({
          offerId: parsed.data.offerId,
          to: row.email,
          token: issued.token,
        });
      } catch (error) {
        await offers.releaseFirstSend(parsed.data.offerId, issued.claimedAt);
        throw error;
      }
      if (emailQueued) await offers.recordSend(parsed.data.offerId, actor);
      else await offers.releaseFirstSend(parsed.data.offerId, issued.claimedAt);
      await audit(subject, "offer.send", parsed.data.offerId, { emailQueued });
      return {
        ok: true,
        link: buildOfferLink(loadEnv().APP_URL, issued.token),
        emailQueued,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "offer.send", entity: "order_offer" },
);

// --- anulare ----------------------------------------------------------------------------------------------------------

export type CancelOfferResult = { ok: true } | Fail;

export const cancelOfferAction = withPermission(
  "orders.offers",
  async (raw: unknown, subject): Promise<CancelOfferResult> => {
    const parsed = z.strictObject({ offerId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      await getOfferService().cancel(parsed.data.offerId, {
        id: subject.userId,
        label: subject.email,
      });
      await audit(subject, "offer.cancel", parsed.data.offerId, {});
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "offer.cancel", entity: "order_offer" },
);
