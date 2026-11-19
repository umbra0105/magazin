import type { Metadata } from "next";
import Link from "next/link";
import { getOrderSummary } from "@ecom/core";
import { redirect } from "next/navigation";
import { Container, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { OrderSummaryView } from "@/components/storefront/order/order-summary-view";
import { readBankDetails, readOrderAccess } from "@/lib/checkout";
import { getCardPayments } from "@/lib/payments";
import { formatDateTime } from "@/lib/format-date";
import { getSettings } from "@/lib/services";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

const m = getMessages().storefront.order;

export const metadata: Metadata = {
  title: m.confirmationTitle,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Confirmarea comenzii (Faza 9): accesul vine DOAR dintr-un cookie semnat, pus la plasare (nu există ID în adresă). Fără el, omul
 * e trimis la urmărire (număr + email). Emailul de confirmare vine în Faza 11, deci pagina spune ce urmează și unde se găsește comanda.
 */
export default async function OrderConfirmationPage() {
  const orderId = await readOrderAccess();
  const summary = orderId ? await getOrderSummary(getDb(), orderId) : null;
  if (!summary) {
    return (
      <Container className="flex flex-col items-start gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.noAccess}</h1>
        <p className="max-w-prose text-ink-secondary">{m.noAccessLede}</p>
        <Link href="/comanda/urmarire" className={storeButtonVariants({ variant: "primary" })}>
          {m.trackLink}
        </Link>
      </Container>
    );
  }
  // card: până la confirmare, clientul stă pe pagina plății (starea vine din notificările procesatorului)
  if (
    summary.paymentMethod === "card" &&
    summary.paymentStatus !== "paid" &&
    summary.status !== "cancelled"
  ) {
    const card = orderId ? await getCardPayments().stateOfOrder(orderId) : null;
    if (card?.paymentId) redirect(`/comanda/plata/${encodeURIComponent(card.paymentId)}`);
  }
  const [format, regional, bank] = await Promise.all([
    getStorefrontFormat(),
    getSettings().getGroup("regional"),
    readBankDetails(),
  ]);
  const checkout = getMessages().storefront.checkout;
  const deadline =
    summary.reservationExpiresAt && summary.paymentMethod === "bank_transfer"
      ? new Intl.DateTimeFormat(format.locale, {
          dateStyle: "long",
          timeZone: regional.timezone,
        }).format(summary.reservationExpiresAt)
      : null;
  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl" data-order-confirmation>
          {m.confirmationTitle}
        </h1>
        <p className="text-lg" data-order-number>
          {m.confirmationLede(summary.number)}
        </p>
        <p className="text-ink-secondary">{m.keepNumber}</p>
      </header>

      <section
        aria-labelledby="next-title"
        className="flex flex-col gap-3 rounded-card bg-card p-6"
      >
        <h2 id="next-title" className="text-lg font-semibold">
          {m.whatNext}
        </h2>
        {summary.paymentMethod === "cod" ? (
          <p>{m.nextCod}</p>
        ) : summary.paymentMethod === "card" ? (
          <p>{summary.paymentNotice === "stock_lost" ? m.stockLostNotice : m.nextCardPaid}</p>
        ) : (
          <>
            <p>{deadline ? m.nextTransfer(deadline) : null}</p>
            {bank ? (
              <dl className="grid gap-1 text-sm" data-bank-details>
                <div className="flex gap-2">
                  <dt className="text-ink-secondary">{checkout.bankHolder}:</dt>
                  <dd>{bank.holder}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-secondary">{checkout.bankName}:</dt>
                  <dd>{bank.bankName}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-secondary">{checkout.bankIban}:</dt>
                  <dd className="font-mono">{bank.iban}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-secondary">{checkout.bankReference}</dt>
                </div>
              </dl>
            ) : null}
          </>
        )}
        <p className="text-sm text-ink-secondary">{m.nextEmail}</p>
        <p>
          <Link href="/comanda/urmarire" className="underline underline-offset-4">
            {m.trackLink}
          </Link>
        </p>
      </section>

      <OrderSummaryView order={summary} format={format} timeZone={regional.timezone} />
      <p className="sr-only">
        {formatDateTime(summary.placedAt, format.locale, regional.timezone)}
      </p>
    </Container>
  );
}
