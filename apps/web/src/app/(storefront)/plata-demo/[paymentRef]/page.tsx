import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";
import { isDemoPaymentAllowed } from "@ecom/integrations";
import { Container, storeButtonVariants } from "@ecom/ui";
import { formatMoney } from "@/lib/money-input";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";
import { demoPayAction } from "../actions";

const m = getMessages().storefront.cardPayment.demo;

export const metadata: Metadata = {
  title: m.title,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Pagina de plată a furnizorului DEMO: simulează pagina procesatorului (succes, sumă greșită, refuz, notificare triplă).
 * Marcată «DEMO» și inexistentă (404) oriunde garda `isDemoPaymentAllowed` nu e îndeplinită, deci niciodată în producție.
 */
export default async function DemoPaymentPage({
  params,
}: {
  params: Promise<{ paymentRef: string }>;
}) {
  if (!isDemoPaymentAllowed(readDemoGuardEnv())) notFound();
  const { paymentRef } = await params;
  const payment =
    paymentRef.length <= 64
      ? await getDb().payment.findUnique({
          where: { id: paymentRef },
          select: {
            id: true,
            provider: true,
            amountMinor: true,
            order: { select: { number: true } },
          },
        })
      : null;
  if (!payment || payment.provider !== "demo") notFound();
  const format = await getStorefrontFormat();
  const button = (scenario: string, label: string, primary = false) => (
    <button
      type="submit"
      name="scenario"
      value={scenario}
      className={storeButtonVariants({ variant: primary ? "primary" : "secondary" })}
      data-demo-scenario={scenario}
    >
      {label}
    </button>
  );
  return (
    <Container className="flex flex-col items-start gap-4 py-12">
      <p
        role="note"
        className="rounded-card bg-tone-warning-bg px-3 py-2 text-sm font-semibold text-tone-warning-fg"
      >
        DEMO · {m.note}
      </p>
      <h1 className="heading-display text-3xl sm:text-4xl">{m.title}</h1>
      <p className="text-lg">
        {m.order(
          payment.order.number,
          formatMoney(payment.amountMinor, format.currency, format.locale),
        )}
      </p>
      <form action={demoPayAction} className="flex flex-wrap gap-3">
        <input type="hidden" name="paymentId" value={payment.id} />
        {button("paid", m.pay, true)}
        {button("wrong", m.payWrong)}
        {button("failed", m.fail)}
        {button("triple", m.triple)}
      </form>
    </Container>
  );
}
