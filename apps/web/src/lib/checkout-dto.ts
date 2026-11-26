import type { CheckoutPreview, PaymentMethodAvailability, RateOffer } from "@ecom/core";
import { pluralRo } from "@ecom/shared";
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
  /** Programul de ridicare personală (`company.pickupHours`), dacă e completat; apare lângă adresa de ridicare. */
  pickupHours?: string | null;
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
  /** Doar ridicarea personală, doar când programul e completat în setări: «Program de ridicare: …»; altfel `null`. */
  hoursLine: string | null;
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

/** Punctele de loialitate la finalizarea comenzii (Faza 15b); toate textele gata formatate. */
export interface CheckoutLoyaltyDto {
  /** Câmpul «Folosește punctele»; `null` = nu se pot folosi acum. */
  redeem: { maxPoints: number; minPoints: number; balanceText: string; maxText: string } | null;
  appliedPoints: number;
  appliedText: string | null;
  /** «Primești X puncte…» sau, la oaspete, «Creează cont și primești X puncte…». */
  note: string | null;
}

export interface CheckoutPreviewDto {
  loyalty: CheckoutLoyaltyDto | null;
  blocked: { code: string; message: string } | null;
  /** Faza 14c: coșul are produse digitale / doar produse digitale (fără pas de livrare, fără ramburs). */
  digital: { present: boolean; only: boolean };
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
    /** Reducerea din puncte, ca linie separată («−50,00 lei»), doar când s-au ales puncte. */
    discountText: string | null;
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
        : offer.kind === "pallet"
          ? text.offerPallet
          : offer.service
            ? `${offer.carrier} — ${offer.service}`
            : offer.carrier,
    priceText:
      offer.priceMinor === 0
        ? text.free
        : formatMoney(offer.priceMinor, format.currency, format.locale),
    free: offer.priceMinor === 0,
    daysText:
      offer.kind === "pickup"
        ? text.pickupLede
        : offer.kind === "pallet" && offer.pallets
          ? text.palletCount(offer.pallets)
          : days === null
            ? null
            : text.days(days),
    addressLine:
      offer.kind === "pickup" && offer.pickupAddress
        ? text.pickupAddress(offer.pickupAddress.text)
        : null,
    addressText: offer.kind === "pickup" ? (offer.pickupAddress?.text ?? null) : null,
    hoursLine:
      offer.kind === "pickup" && format.pickupHours ? text.pickupHours(format.pickupHours) : null,
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
      offer?.kind === "pallet"
        ? fee > 0
          ? text.paymentCodHelpPallet(money(fee))
          : text.paymentCodFreePallet
        : offer?.kind === "pickup"
          ? fee > 0
            ? text.paymentCodHelpPickup(money(fee))
            : text.paymentCodFreePickup
          : fee > 0
            ? text.paymentCodHelp(money(fee))
            : text.paymentCodFree,
    reasonText: reason,
  };
}

export const pointsText = (points: number): string =>
  pluralRo(points, "punct", "puncte", "de puncte");

function loyaltyDto(
  preview: CheckoutPreview,
  money: (minor: number) => string,
): CheckoutLoyaltyDto | null {
  const loyalty = preview.loyalty;
  if (!loyalty) return null;
  const text = m().loyalty;
  const redeem = loyalty.redeem;
  const value = (points: number) => money(points * (redeem?.pointValueMinor ?? 0));
  return {
    redeem: redeem
      ? {
          maxPoints: redeem.maxPoints,
          minPoints: redeem.minPoints,
          balanceText: text.balance(pointsText(loyalty.balance), value(loyalty.balance)),
          maxText: text.max(pointsText(redeem.maxPoints), value(redeem.maxPoints)),
        }
      : null,
    appliedPoints: loyalty.appliedPoints,
    appliedText:
      redeem && loyalty.appliedPoints > 0
        ? text.applied(pointsText(loyalty.appliedPoints), value(loyalty.appliedPoints))
        : null,
    note:
      loyalty.earns && loyalty.earnEstimate > 0
        ? (loyalty.signedIn ? text.earnMember : text.earnGuest)(pointsText(loyalty.earnEstimate))
        : null,
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
    loyalty: loyaltyDto(preview, money),
    blocked: preview.blocked,
    digital: preview.digital ?? { present: false, only: false },
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
          discountText: preview.totals.discountMinor
            ? `−${money(preview.totals.discountMinor)}`
            : null,
          vatText: money(preview.totals.taxMinor),
          totalText: money(preview.totals.totalMinor),
          totalMinor: preview.totals.totalMinor,
        }
      : null,
  };
}
