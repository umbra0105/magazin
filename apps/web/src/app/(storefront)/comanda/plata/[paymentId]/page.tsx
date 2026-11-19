import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@ecom/db";
import { Container, storeButtonVariants } from "@ecom/ui";
import { CardPaymentStatus } from "@/components/storefront/payment/card-payment-status";
import { toPaymentStateDto } from "@/lib/card-payment-view";
import { readOrderAccess } from "@/lib/checkout";
import { getCardPayments } from "@/lib/payments";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cardPayment;

export const metadata: Metadata = {
  title: m.title,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Pagina de retur și de așteptare a plății cu cardul (Faza 10). Nu confirmă nimic doar pe baza returului clientului: starea vine din
 * baza noastră, actualizată de notificările procesatorului. Accesul cere cookie-ul semnat de la plasare (ID-ul din adresă nu
 * ajunge); fără el, omul e trimis la urmărirea comenzii (număr + email).
 */
export default async function CardPaymentPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = await params;
  const orderId = await readOrderAccess();
  const payment =
    orderId && paymentId.length <= 64
      ? await getDb().payment.findUnique({ where: { id: paymentId }, select: { orderId: true } })
      : null;
  const view =
    payment && payment.orderId === orderId
      ? await getCardPayments().stateOfOrder(payment.orderId)
      : null;
  if (!view) {
    return (
      <Container className="flex flex-col items-start gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.noAccess}</h1>
        <p className="max-w-prose text-ink-secondary">{m.noAccessBody}</p>
        <Link href="/comanda/urmarire" className={storeButtonVariants({ variant: "primary" })}>
          {m.track}
        </Link>
      </Container>
    );
  }
  const regional = await getSettings().getGroup("regional");
  return (
    <Container className="flex flex-col gap-3 py-8 sm:py-12">
      <h1 className="text-lg font-medium text-ink-secondary">{m.title}</h1>
      <CardPaymentStatus paymentId={paymentId} initial={toPaymentStateDto(view, regional)} />
    </Container>
  );
}
