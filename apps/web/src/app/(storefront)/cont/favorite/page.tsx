import type { Metadata } from "next";
import { listWishlistProducts } from "@ecom/core";
import { getDb } from "@ecom/db";
import { ProductCardView } from "@/components/storefront/catalog/product-grid";
import { WishlistButton } from "@/components/storefront/account/wishlist-button";
import { requireCustomer, requireFlag } from "@/lib/account";
import { getCatalogReader, getStorefrontFormat } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.favorites.title };
export const dynamic = "force-dynamic";

/**
 * Produsele favorite ale clientului (Faza 14, în spatele flag-ului `wishlist`: oprit = 404, nicio interogare). Prețurile și starea de
 * stoc vin din aceleași citiri ca în liste (nu există calcule duplicate aici); un produs dezactivat sau dispărut apare marcat, cu
 * opțiunea de a-l scoate. Nimic din prețul de achiziție nu trece pe aici.
 */
export default async function FavoritesPage() {
  await requireFlag("wishlist");
  const { user } = await requireCustomer("/cont/favorite");
  const entries = await listWishlistProducts(getDb(), user.id);
  const format = await getStorefrontFormat();
  const chrome = await getStorefrontChrome();
  const productIds = [...new Set(entries.map((e) => e.productId))];
  const listed = await getCatalogReader().listedByIds(productIds, format);
  const listedById = new Map(listed.map((p) => [p.id, p]));
  const items = entries.map((e) => ({
    variantId: e.variantId,
    title: e.title,
    product: listedById.get(e.productId) ?? null,
  }));
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.favorites.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.favorites.lede}</p>
      </header>
      {items.length === 0 ? (
        <p className="text-ink-secondary" data-favorites-empty>
          {m.favorites.empty}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-favorites>
          {items.map((item) => (
            <li key={item.variantId} className="flex flex-col gap-2" data-favorite>
              {item.product ? (
                <ProductCardView
                  product={item.product}
                  format={format}
                  layout={chrome.cardLayout}
                  headingLevel={2}
                  wishlist
                />
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-card bg-card p-4">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-sm text-ink-secondary">{m.favorites.disabled}</p>
                  </div>
                  <WishlistButton variantId={item.variantId} name={item.title} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
