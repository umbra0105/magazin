import type { CheckoutPreview, PaymentMethodAvailability, RateOffer } from "@ecom/core";
import { getMessages } from "@/messages";
import { formatMoney } from "./money-input";

/**
 * Previzualizarea checkout-ului pentru interfață: toate textele (bani, termene, motivele pentru care o metodă lipsește) gata
 * formatate pe SERVER, ca în browser să nu ajungă nicio regulă de preț, de livrare sau de ramburs. Funcție PURĂ, testată pe
 * valori: primește rezultatul `CheckoutService.preview` și formatul (moneda și limba din setări).
 */

const m = () => getMessages().storefront.checkout;

export interface CheckoutFormat {
  currency: string;
  locale: string;
}

export interface CheckoutOfferDto {
  code: string;
  kind: "courier" | "easybox" | "pickup" | "pallet";
  label: string;
  priceText: string;
  free: boolean;
  daysText: string | null;
  /** Doar ridicarea personală: adresa MAGAZINULUI, formatată («Adresa de ridicare: …»); altfel `null`. */
  addressLine: string | null;
  /** Doar ridicarea personală: adresa magazinului, fără prefix (pentru rezumate); altfel `null`. */
  addressText: string | null;
  /** Tarif demonstrativ (furnizorul DEMO): se arată cu o etichetă, ca să nu fie luat drept tarif real. */
  demo: boolean;
}

export interface CheckoutMethodDto {
  method: "cod" | "bank_transfer" | "card";
  available: boolean;
  label: string;
  helpText: string;
  reasonText: string | null;
}

export interface CheckoutPreviewDto {
  blocked: { code: string; message: string } | null;
  destination: { countyName: string; localityName: string } | null;
  offers: CheckoutOfferDto[];
  selectedOfferCode: string | null;
  fallbackUsed: boolean;
  incomplete: boolean;
  leadTimeText: string | null;
  methods: CheckoutMethodDto[] | null;
  totals: {
    productsText: string;
    shippingText: string;
    shippingFree: boolean;
    codFeeText: string | null;
    vatText: string;
    totalText: string;
    totalMinor: number;
  } | null;
}

export interface DtoLimits {
  codMaxIndividualMinor: number;
  codMaxCompanyMinor: number;
}

function offerDto(offer: RateOffer, format: CheckoutFormat): CheckoutOfferDto {
  const text = m();
  const days = offer.estimatedDays;
  return {
    code: offer.code,
    kind: offer.kind,
    label:
      offer.kind === "pickup"
        ? text.pickup
        : offer.service
          ? `${offer.carrier} — ${offer.service}`
          : offer.carrier,
    priceText:
      offer.priceMinor === 0
        ? text.free
        : formatMoney(offer.priceMinor, format.currency, format.locale),
    free: offer.priceMinor === 0,
    daysText: offer.kind === "pickup" ? text.pickupLede : days === null ? null : text.days(days),
    addressLine:
      offer.kind === "pickup" && offer.pickupAddress
        ? text.pickupAddress(offer.pickupAddress.text)
        : null,
    addressText: offer.kind === "pickup" ? (offer.pickupAddress?.text ?? null) : null,
    demo: offer.demo,
  };
}

function methodDto(
  entry: PaymentMethodAvailability,
  offer: RateOffer | null,
  limits: DtoLimits,
  format: CheckoutFormat,
  isCompany: boolean,
): CheckoutMethodDto {
  const text = m();
  const money = (minor: number) => formatMoney(minor, format.currency, format.locale);
  if (entry.method === "card") {
    return {
      method: "card",
      available: true,
      label: text.paymentCard,
      helpText: text.paymentCardHelp,
      reasonText: null,
    };
  }
  if (entry.method === "bank_transfer") {
    return {
      method: "bank_transfer",
      available: entry.available,
      label: text.paymentTransfer,
      helpText: text.paymentTransferHelp,
      reasonText: null,
    };
  }
  const fee = offer?.codFeeMinor ?? 0;
  const reason = entry.available
    ? null
    : entry.reason === "has_on_order_line"
      ? text.codReasons.has_on_order_line
      : entry.reason === "over_limit_company"
        ? text.codReasons.over_limit_company(money(limits.codMaxCompanyMinor))
        : text.codReasons.over_limit_individual(
            money(isCompany ? limits.codMaxCompanyMinor : limits.codMaxIndividualMinor),
          );
  return {
    method: "cod",
    available: entry.available,
    label: text.paymentCod,
    helpText:
      offer?.kind === "pickup"
        ? fee > 0
          ? text.paymentCodHelpPickup(money(fee))
          : text.paymentCodFreePickup
        : fee > 0
          ? text.paymentCodHelp(money(fee))
          : text.paymentCodFree,
    reasonText: reason,
  };
}

export function toCheckoutPreviewDto(
  preview: CheckoutPreview,
  format: CheckoutFormat,
  limits: DtoLimits,
  options: { isCompany: boolean },
): CheckoutPreviewDto {
  const text = m();
  const money = (minor: number) => formatMoney(minor, format.currency, format.locale);
  const offers = preview.shipping?.offers.map((offer) => offerDto(offer, format)) ?? [];
  const reference = preview.selectedOffer ?? preview.shipping?.offers[0] ?? null;
  return {
    blocked: preview.blocked,
    destination: preview.destination,
    offers,
    selectedOfferCode: preview.selectedOffer?.code ?? null,
    fallbackUsed: preview.shipping?.fallbackUsed ?? false,
    incomplete: preview.shipping?.incomplete ?? false,
    leadTimeText: preview.view.leadTime ? text.leadTime(preview.view.leadTime.days) : null,
    methods: preview.methods
      ? preview.methods.map((entry) =>
          methodDto(entry, reference, limits, format, options.isCompany),
        )
      : null,
    totals: preview.totals
      ? {
          productsText: money(preview.totals.subtotalMinor),
          shippingText:
            preview.totals.shippingMinor === 0 ? text.free : money(preview.totals.shippingMinor),
          shippingFree: preview.totals.shippingMinor === 0,
          codFeeText: preview.totals.codFeeMinor > 0 ? money(preview.totals.codFeeMinor) : null,
          vatText: money(preview.totals.taxMinor),
          totalText: money(preview.totals.totalMinor),
          totalMinor: preview.totals.totalMinor,
        }
      : null,
  };
}
