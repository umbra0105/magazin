import type { Metadata } from "next";
import Link from "next/link";
import { getOrderSummary } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Container, storeButtonVariants } from "@ecom/ui";
import { PayByLinkButton } from "@/components/storefront/payment/pay-by-link-button";
import { getCardPayments } from "@/lib/payments";
import { formatMoney } from "@/lib/money-input";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cardPayment;

export const metadata: Metadata = {
  title: m.link.title,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Linkul «reîncearcă plata» (valabil 24 h): jeton aleatoriu în adresă, cu amprenta în bază. Un jeton necunoscut, expirat sau al unei
 * comenzi deja plătite sau anulate arată același mesaj (nicio informație despre ce există). Comanda se arată doar cu număr și
 * total; nimic personal.
 */
export default async function PayByLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await getCardPayments().resolveRetryToken(token);
  const order = resolved ? await getOrderSummary(getDb(), resolved.orderId) : null;
  if (!resolved || !order || order.status !== "pending") {
    return (
      <Container className="flex flex-col items-start gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.link.invalidTitle}</h1>
        <p className="max-w-prose text-ink-secondary">{m.link.invalidBody}</p>
        <Link href="/comanda/urmarire" className={storeButtonVariants({ variant: "primary" })}>
          {m.track}
        </Link>
      </Container>
    );
  }
  const format = await getStorefrontFormat();
  return (
    <Container className="flex flex-col items-start gap-4 py-12">
      <h1 className="heading-display text-3xl sm:text-4xl">{m.link.title}</h1>
      <p className="max-w-prose text-lg">
        {m.link.body(
          order.number,
          formatMoney(order.totals.totalMinor, format.currency, format.locale),
        )}
      </p>
      <PayByLinkButton token={token} />
    </Container>
  );
}
