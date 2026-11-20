import { Lock } from "lucide-react";
import Link from "next/link";
import { Container } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.checkout;

/**
 * Antetul checkout-ului «curat» (docs/03 §2): doar logo-ul magazinului, indicatorul de securitate și legătura înapoi la coș. Fără
 * meniu, căutare sau subsol, ca nimic să nu distragă de la finalizarea comenzii.
 */
export function CheckoutHeader({
  storeName,
  logoUrl,
  backToCart = true,
}: {
  storeName: string;
  logoUrl: string | null;
  /** `false` la pagina ofertei: clientul vine dintr-un email și nu are coș; ieșirea rămâne logo-ul, către pagina de start. */
  backToCart?: boolean;
}) {
  return (
    <header className="border-b border-line-subtle bg-surface-page" data-checkout-header>
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center rounded-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page"
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo din Branding (https sau cale locală), cu dimensiune fixă
            <img src={logoUrl} alt={storeName} className="h-9 w-auto max-w-48" />
          ) : (
            <span className="heading-display text-xl">{storeName}</span>
          )}
        </Link>
        <p className="flex items-center gap-2 text-sm text-ink-secondary" data-checkout-secure>
          <Lock aria-hidden="true" className="size-4" />
          {m.secure}
        </p>
        {backToCart ? (
          <Link
            href="/cos"
            className="min-h-11 content-center text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {m.backToCart}
          </Link>
        ) : null}
      </Container>
    </header>
  );
}
