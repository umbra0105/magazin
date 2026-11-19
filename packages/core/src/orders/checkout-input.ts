import { z } from "zod";
import { PAYMENT_METHODS } from "./payment-rules";

/**
 * Intrarea de la checkout, validată cu Zod la marginea sistemului (formular → acțiune de server). Nimic de aici nu e de încredere:
 * totalul, prețurile, oferta de livrare și textul consimțământului se recalculează sau se iau pe server; clientul trimite doar
 * ce a ales și totalul pe care l-a văzut (`expectedTotalMinor`), ca o schimbare să nu treacă pe nesimțite.
 */

/** Telefon românesc, normalizat la `+40…` (accepte `07…`, `+40…`, `0040…`, cu spații, puncte sau cratime). */
export function normalizeRoPhone(input: string): string | null {
  const compact = input.replace(/[\s.\-()]/g, "");
  const match = /^(?:\+40|0040|0)(\d{9})$/.exec(compact);
  return match ? `+40${match[1]}` : null;
}

const phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeRoPhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Numărul de telefon nu este valid" });
      return z.NEVER;
    }
    return normalized;
  });

export const addressInputSchema = z.object({
  fullName: z.string().trim().min(2, "Scrie numele complet").max(120),
  phone,
  countyCode: z.number().int().positive(),
  localityCode: z.number().int().positive(),
  street: z.string().trim().min(3, "Scrie strada și numărul").max(200),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Codul poștal are 6 cifre"),
  country: z.string().trim().length(2).toUpperCase().default("RO"),
});
export type AddressInput = z.infer<typeof addressInputSchema>;

export const companyInputSchema = z.object({
  name: z.string().trim().min(2, "Scrie denumirea firmei").max(200),
  /** CUI cu sau fără prefixul RO; formatul și cifra de control se verifică pe server. */
  vatId: z.string().trim().min(2).max(20),
  tradeRegisterNo: z.string().trim().max(40).optional(),
});
export type CompanyInput = z.infer<typeof companyInputSchema>;

export const placeOrderInputSchema = z.object({
  /** Cheia de idempotență a acestei încercări (protecție la dublu-click și la reîncercări). */
  idempotencyKey: z.string().uuid(),
  /** Totalul văzut de client, în bani; dacă serverul calculează altul, comanda nu se plasează. */
  expectedTotalMinor: z.number().int().min(1),
  contact: z.object({
    email: z.string().trim().toLowerCase().email("Adresa de email nu este validă").max(254),
    phone,
  }),
  shipping: addressInputSchema,
  /** Facturare: aceeași adresă, sau una proprie. */
  billing: z.discriminatedUnion("sameAsShipping", [
    z.object({ sameAsShipping: z.literal(true) }),
    z.object({ sameAsShipping: z.literal(false), address: addressInputSchema }),
  ]),
  /** Persoană juridică: CUI la facturare. */
  company: companyInputSchema.nullable().default(null),
  shippingOfferCode: z.string().min(1).max(100),
  paymentMethod: z.enum(PAYMENT_METHODS),
  customerNote: z.string().trim().max(1000).optional(),
  installation: z
    .object({ requested: z.boolean(), note: z.string().trim().max(1000).optional() })
    .default({ requested: false }),
  /** Acceptarea Termenilor: trebuie să fie `true`, pentru versiunea textului afișat. */
  consent: z.object({ accepted: z.literal(true), version: z.string().min(1).max(50) }),
});
export type PlaceOrderInput = z.infer<typeof placeOrderInputSchema>;
