import type { Metadata } from "next";
import Link from "next/link";
import { CHECKOUT_TERMS_CONSENT } from "@ecom/core";
import { Container, storeButtonVariants } from "@ecom/ui";
import { CheckoutFlow } from "@/components/storefront/checkout/checkout-flow";
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
 * Pagina `/checkout` (Faza 9): o singură pagină, cu pași accordion (docs/03 §2), doar pentru oaspete, cu ramburs sau transfer
 * bancar. Un coș gol sau cu probleme nu ajunge la formular: omul e trimis înapoi în coș, cu explicație. Totul se recalculează
 * pe server la fiecare pas și la plasare; aici se încarcă doar datele de pornire (coșul, județele, textele din setări).
 */
export default async function CheckoutPage() {
  const [{ owner }, format] = await Promise.all([resolveCartOwner(), getStorefrontFormat()]);
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
      />
    </Container>
  );
}
