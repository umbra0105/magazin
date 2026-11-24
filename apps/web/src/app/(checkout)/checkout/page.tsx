import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CHECKOUT_TERMS_CONSENT, consentSnapshot, readDigitalSettings } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Container, storeButtonVariants } from "@ecom/ui";
import { CheckoutFlow } from "@/components/storefront/checkout/checkout-flow";
import { VerifyEmailNotice } from "@/components/storefront/checkout/verify-email-notice";
import { getCustomer } from "@/lib/account";
import { getCartService, resolveCartOwner } from "@/lib/cart";
import { toCartDto } from "@/lib/cart-dto";
import { getGeoService, readBankDetails, transferDeadlineText } from "@/lib/checkout";
import { getSettings } from "@/lib/services";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

const m = getMessages().storefront.checkout;

export const metadata: Metadata = {
  title: m.title,
  robots: { index: false, follow: false },
};

// Citește cookie-ul coșului: pagina e dinamică.
export const dynamic = "force-dynamic";

/**
 * Pagina `/checkout` (Faza 9): o singură pagină, cu pași accordion (docs/03 §2), pentru oaspete (produse fizice) sau pentru un cont
 * verificat (produse digitale, Faza 14c: oaspetele e trimis la autentificare, cu întoarcere aici și coșul păstrat). Un coș gol sau cu probleme nu ajunge la formular: omul e trimis înapoi în coș, cu explicație. Totul se recalculează
 * pe server la fiecare pas și la plasare; aici se încarcă doar datele de pornire (coșul, județele, textele din setări).
 */
export default async function CheckoutPage() {
  const [{ owner }, format, customer] = await Promise.all([
    resolveCartOwner(),
    getStorefrontFormat(),
    getCustomer(),
  ]);
  const view = await getCartService().view(owner);
  const cart = toCartDto(view, format);

  if (view.lines.length === 0 || !view.canCheckout) {
    return (
      <Container className="flex flex-col items-start gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">
          {view.lines.length === 0 ? m.emptyTitle : m.title}
        </h1>
        <p className="max-w-prose text-ink-secondary" data-checkout-blocked>
          {view.lines.length === 0 ? m.emptyLede : m.blocked}
        </p>
        <Link href="/cos" className={storeButtonVariants({ variant: "primary" })}>
          {m.backToCart}
        </Link>
      </Container>
    );
  }

  // produsele digitale se comandă doar cu un cont verificat: oaspetele merge la autentificare (coșul se îmbină la intrare)
  const hasDigital = view.lines.some((line) => line.isDigital === true);
  const digitalOnly = hasDigital && view.lines.every((line) => line.isDigital === true);
  if (hasDigital && !customer) redirect(`/autentificare?next=${encodeURIComponent("/checkout")}`);
  if (hasDigital && customer && !customer.user.emailVerified) {
    return (
      <Container className="flex flex-col gap-4 py-12">
        <h1 className="heading-display text-3xl sm:text-4xl">
          {getMessages().digital.checkout.verifyTitle}
        </h1>
        <VerifyEmailNotice email={customer.user.email} />
      </Container>
    );
  }
  const digitalConsent = hasDigital
    ? consentSnapshot((await readDigitalSettings(getDb())).consentText)
    : null;

  const [counties, bank, transferDeadline, shipping] = await Promise.all([
    getGeoService().counties(),
    readBankDetails(),
    transferDeadlineText(),
    getSettings().getGroup("shipping"),
  ]);

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <h1 className="heading-display text-3xl sm:text-4xl">{m.title}</h1>
      <CheckoutFlow
        counties={counties.map((county) => ({ code: county.code, label: county.name }))}
        cart={cart}
        consent={{ text: CHECKOUT_TERMS_CONSENT.text, version: CHECKOUT_TERMS_CONSENT.version }}
        bank={bank}
        transferDeadline={transferDeadline}
        groundNotice={shipping.groundLevelNotice}
        digital={{ present: hasDigital, only: digitalOnly }}
        digitalConsent={digitalConsent}
        accountEmail={hasDigital && customer ? customer.user.email : null}
      />
    </Container>
  );
}
