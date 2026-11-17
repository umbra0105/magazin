import type { Metadata } from "next";
import { Container, SectionHeading } from "@ecom/ui";
import { CartPanel } from "@/components/storefront/cart/cart-panel";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import { getCartService, resolveCartOwner } from "@/lib/cart";
import {
  getCatalogReader,
  getStorefrontFormat,
  listProductsCached,
} from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cart;

/** Coșul e pagină privată: nu se indexează (și `robots.txt` o interzice, docs/19 §1). */
export const metadata: Metadata = {
  title: m.title,
  robots: { index: false, follow: false },
};

// Citește cookie-ul coșului: pagina e dinamică, iar cadrul (header, footer) rămâne din cache.
export const dynamic = "force-dynamic";

const SUGGESTIONS = 4;

/**
 * Pagina `/cos` (Faza 8; anunțurile `aria-live` vin din regiunea unică a header-ului): conținutul e `CartPanel` (același ca în sertar), încărcat de la server la fiecare afișare, cu prețurile și
 * stocul recalculate. Sub el: cross-sell din relațiile «crosssell» ale produselor din coș (doar produse vandabile) sau, la coș
 * gol, produse recomandate. Finalizarea comenzii e dezactivată până în Faza 9.
 */
export default async function CartPage() {
  const [chrome, format, { owner }] = await Promise.all([
    getStorefrontChrome(),
    getStorefrontFormat(),
    resolveCartOwner(),
  ]);
  const cart = getCartService();
  const hasLines = (await cart.lineCount(owner)) > 0;
  const suggested = hasLines
    ? await getCatalogReader().listedByIds(
        await cart.crossSellProductIds(owner, SUGGESTIONS),
        format,
      )
    : (await listProductsCached({}, "recommended", 0, SUGGESTIONS, format)).items;

  return (
    <Container className="flex flex-col gap-10 py-8 sm:py-12">
      <h1 className="heading-display text-4xl sm:text-5xl">{m.title}</h1>
      <CartPanel variant="page" />
      {suggested.length > 0 ? (
        <section className="flex flex-col gap-6">
          <SectionHeading compact title={m.suggestionsTitle} />
          <ProductGrid
            products={suggested}
            format={format}
            layout={chrome.cardLayout}
            label={m.suggestionsTitle}
          />
        </section>
      ) : null}
    </Container>
  );
}
