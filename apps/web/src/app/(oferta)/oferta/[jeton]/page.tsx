import type { Metadata } from "next";
import Link from "next/link";
import { CHECKOUT_TERMS_CONSENT, type PublicOffer } from "@ecom/core";
import { Container, storeButtonVariants } from "@ecom/ui";
import { OfferContinue } from "@/components/storefront/offer/offer-continue";
import { OfferPay } from "@/components/storefront/offer/offer-pay";
import { allowCheckoutRequest } from "@/lib/checkout";
import { formatMoney } from "@/lib/money-input";
import { getOfferService } from "@/lib/offers";
import { getSettings } from "@/lib/services";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

const m = getMessages().storefront.offer;

/** Pagina e personală: nu se indexează, iar jetonul din adresă nu pleacă mai departe prin antetul Referer. */
export const metadata: Metadata = {
  title: m.pageTitle,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

function Unavailable() {
  return (
    <Container className="flex flex-col items-start gap-4 py-12">
      <h1 className="heading-display text-3xl sm:text-4xl">{m.unavailable.title}</h1>
      <p className="max-w-prose text-ink-secondary">{m.unavailable.body}</p>
      <Link href="/" className={storeButtonVariants({ variant: "primary" })}>
        {m.unavailable.home}
      </Link>
    </Container>
  );
}

function Lines({ offer, money }: { offer: PublicOffer; money: (minor: number) => string }) {
  return (
    <section aria-labelledby="oferta-produse" className="flex flex-col gap-3">
      <h2 id="oferta-produse" className="text-xl font-semibold">
        {m.productsHeading}
      </h2>
      <ul className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
        {offer.lines.map((line) => (
          <li key={line.sku} className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between">
            <div>
              <p className="font-medium">{line.title}</p>
              {line.variantTitle ? (
                <p className="text-sm text-ink-secondary">{line.variantTitle}</p>
              ) : null}
              <p className="text-sm text-ink-secondary">
                {m.quantity}: {line.quantity} {line.unitSymbol} · {m.unitPrice}:{" "}
                {money(line.unitPriceMinor)}
              </p>
              {line.leadTimeDays !== null ? (
                <p className="text-sm text-ink-secondary">{m.onOrder(line.leadTimeDays ?? 0)}</p>
              ) : line.state === "limited" ? (
                <p className="text-sm text-ink-secondary">{m.limited}</p>
              ) : null}
            </div>
            <p className="font-medium sm:text-right">{money(line.lineTotalMinor)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function OfferPage({ params }: { params: Promise<{ jeton: string }> }) {
  const { jeton } = await params;
  // limita pe IP: la depășire, același ecran ca pentru un jeton necunoscut (nu se deosebesc)
  if (!(await allowCheckoutRequest("offerView"))) return <Unavailable />;
  const offer = await getOfferService().publicView(jeton);
  if (!offer) return <Unavailable />;

  const consent = {
    text: CHECKOUT_TERMS_CONSENT.text,
    version: CHECKOUT_TERMS_CONSENT.version,
  };
  if (offer.status === "converted") {
    // plata cu cardul s-a oprit, dar comanda mai poate fi plătită: «Continuă plata» (mecanismul de reîncercare din Faza 10);
    // plătită, anulată sau cu fereastra trecută: doar mesajul că oferta e folosită, fără nicio acțiune
    if (offer.canContinuePayment) {
      return (
        <Container className="flex max-w-3xl flex-col items-start gap-4 py-12">
          <h1 className="heading-display text-3xl sm:text-4xl">{m.converted.continueTitle}</h1>
          <p className="max-w-prose text-ink-secondary">{m.converted.continueBody}</p>
          <OfferContinue token={jeton} />
        </Container>
      );
    }
    return (
      <Container className="flex max-w-3xl flex-col items-start gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.converted.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.converted.body}</p>
        <Link href="/" className={storeButtonVariants({ variant: "primary" })}>
          {m.unavailable.home}
        </Link>
      </Container>
    );
  }

  const [format, regional] = await Promise.all([
    getStorefrontFormat(),
    getSettings().getGroup("regional"),
  ]);
  const money = (minor: number) => formatMoney(minor, format.currency, format.locale);
  const until = new Intl.DateTimeFormat(format.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: regional.timezone,
  }).format(offer.expiresAt);

  return (
    <Container className="flex flex-col gap-8 py-10 lg:py-12">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.title(offer.number)}</h1>
        <p className="max-w-prose text-ink-secondary">{m.lede}</p>
        <p className="text-sm text-ink-secondary">{m.validUntil(until)}</p>
      </header>
      {/* pe calculator: produsele și livrarea în stânga, rezumatul și plata în dreapta (fixat), deci bifa și butonul se văd de la
          prima vedere, deasupra bannerului de cookie-uri; pe telefon rămân una sub alta, în ordinea citirii */}
      <div className="grid gap-8 lg:grid-cols-12 lg:items-start">
        <div className="flex min-w-0 flex-col gap-8 lg:col-span-7 xl:col-span-8">
          <Lines offer={offer} money={money} />
          <section aria-labelledby="oferta-livrare" className="flex flex-col gap-1">
            <h2 id="oferta-livrare" className="text-xl font-semibold">
              {m.deliveryHeading}
            </h2>
            <p>
              {offer.delivery
                ? m.deliveryCourier(
                    offer.delivery.fullName,
                    `${offer.delivery.street}, ${offer.delivery.localityName}, ${offer.delivery.countyName}, ${offer.delivery.postalCode}`,
                  )
                : m.deliveryPickup}
            </p>
          </section>
        </div>
        <div
          className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-6 lg:col-span-5 lg:rounded-card lg:bg-card lg:p-6 xl:col-span-4"
          data-offer-summary
        >
          <section aria-labelledby="oferta-totaluri" className="flex flex-col gap-2">
            <h2 id="oferta-totaluri" className="text-xl font-semibold">
              {m.totalsHeading}
            </h2>
            <dl className="flex flex-col gap-1">
              <div className="flex justify-between">
                <dt>{m.products}</dt>
                <dd>{money(offer.subtotalMinor)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>{m.shipping}</dt>
                <dd>{offer.shippingMinor === 0 ? m.shippingFree : money(offer.shippingMinor)}</dd>
              </div>
              <div className="flex justify-between text-sm text-ink-secondary">
                <dt>{m.vat}</dt>
                <dd>{money(offer.taxMinor)}</dd>
              </div>
              <div className="flex justify-between border-t border-line-subtle pt-2 text-lg font-semibold">
                <dt>{m.total}</dt>
                <dd data-offer-total>{money(offer.totalMinor)}</dd>
              </div>
            </dl>
          </section>
          <OfferPay token={jeton} consent={consent} />
        </div>
      </div>
    </Container>
  );
}
