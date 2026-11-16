import { ProductCard, StoreImage } from "@ecom/ui";
import type { CardLayout, ListedProduct } from "@ecom/core";
import { formatPrice, type StorefrontFormat } from "@/lib/storefront-catalog";
import { productHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";
import { availabilityDetail, availabilityLabel, availabilityTone } from "./availability";

const m = getMessages().storefront.catalog;

type Format = Pick<StorefrontFormat, "currency" | "locale">;

/**
 * Cardul de produs din liste: leagă datele publice ale produsului de componenta din `@ecom/ui`. Prețul vine gata calculat din
 * câmpurile existente (fără motor de prețuri); cu `isRange` arată «de la». Prima imagine din ecran primește `priority` (LCP).
 */
export function ProductCardView({
  product,
  format,
  layout,
  headingLevel = 3,
  priority = false,
}: {
  product: ListedProduct;
  format: Format;
  layout: CardLayout;
  headingLevel?: 2 | 3;
  priority?: boolean;
}) {
  const price = product.price;
  const amount = price ? formatPrice(price.amount, format) : m.card.noPrice;
  const detail = availabilityDetail(product.availability);
  const label = availabilityLabel(product.availability.state);
  return (
    <ProductCard
      href={productHref(product.slug)}
      name={product.title}
      brand={product.brandName ?? undefined}
      media={
        product.image ? (
          <StoreImage
            src={product.image.src}
            alt={product.image.alt}
            width={product.image.width}
            height={product.image.height}
            sizes="(min-width: 64rem) 25vw, (min-width: 40rem) 33vw, 50vw"
            priority={priority}
          />
        ) : null
      }
      price={price?.isRange ? m.card.from(amount) : amount}
      oldPrice={price?.compareAt ? formatPrice(price.compareAt, format) : undefined}
      status={{
        label: detail ? `${label} · ${detail}` : label,
        tone: availabilityTone(product.availability.state),
      }}
      headingLevel={headingLevel}
      layout={layout}
    />
  );
}

/** Grila de carduri: o listă reală (`ul`), 2 coloane pe telefon, mai multe pe ecrane late. Primele două imagini se încarcă cu prioritate. */
export function ProductGrid({
  products,
  format,
  layout,
  headingLevel = 3,
  label,
}: {
  products: readonly ListedProduct[];
  format: Format;
  layout: CardLayout;
  headingLevel?: 2 | 3;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className={
        layout === "horizontal"
          ? "grid gap-4"
          : "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4"
      }
    >
      {products.map((product, index) => (
        <li key={product.id} className="contents">
          <ProductCardView
            product={product}
            format={format}
            layout={layout}
            headingLevel={headingLevel}
            priority={index < 2}
          />
        </li>
      ))}
    </ul>
  );
}
