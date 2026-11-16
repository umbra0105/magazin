import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageWindow, parseListingPage, parseListingSort } from "@ecom/core";
import { Container, StoreButton, StorefrontState } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import {
  ListingPagination,
  ListingSortLinks,
} from "@/components/storefront/catalog/listing-controls";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import { getStorefrontFormat, listProductsCached } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { SHOP_PATH, listingHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const query = await searchParams;
  const { storeName } = await getStorefrontChrome();
  const page = parseListingPage(query["pagina"]);
  const sorted = parseListingSort(query["sortare"]) !== "recommended";
  return {
    title: page > 1 ? `${m.shop.title} - ${m.pagination.page(page)}` : m.shop.title,
    description: m.shop.metaDescription(storeName),
    alternates: { canonical: listingHref(SHOP_PATH, { page }) },
    robots: sorted ? { index: false, follow: true } : undefined,
  };
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const sort = parseListingSort(query["sortare"]);
  const [chrome, format] = await Promise.all([getStorefrontChrome(), getStorefrontFormat()]);
  const first = await listProductsCached({}, sort, 0, 1, format);
  const window = pageWindow(parseListingPage(query["pagina"]), first.total, format.productsPerPage);
  if (window.outOfRange) notFound();
  const { items } = await listProductsCached(
    {},
    sort,
    window.offset,
    format.productsPerPage,
    format,
  );

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <Breadcrumbs items={[{ name: m.breadcrumbs.home, href: "/" }]} current={m.breadcrumbs.shop} />
      <header className="flex flex-col gap-3">
        <h1 className="heading-display text-headline text-balance">{m.shop.title}</h1>
        <p className="text-sm text-ink-secondary">{m.total(first.total)}</p>
      </header>
      {items.length === 0 ? (
        <StorefrontState
          title={m.empty.title}
          description={m.empty.description}
          actions={
            <Link href="/">
              <StoreButton>{m.breadcrumbs.home}</StoreButton>
            </Link>
          }
        />
      ) : (
        <>
          <ListingSortLinks base={SHOP_PATH} current={sort} />
          <ProductGrid
            products={items}
            format={format}
            layout={chrome.cardLayout}
            label={m.shop.title}
          />
          <ListingPagination
            base={SHOP_PATH}
            sort={sort}
            page={window.page}
            pageCount={window.pageCount}
          />
        </>
      )}
    </Container>
  );
}
