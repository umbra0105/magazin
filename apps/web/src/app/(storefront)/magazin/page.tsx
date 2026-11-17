import type { Metadata } from "next";
import Link from "next/link";
import {
  hasActiveFilters,
  parseListingFilters,
  parseListingPage,
  parseListingSort,
} from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { Container } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import { CatalogListing } from "@/components/storefront/catalog/catalog-listing";
import { JsonLdScript } from "@/components/storefront/json-ld";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { breadcrumbList } from "@/lib/structured-data";
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
  const variant =
    parseListingSort(query["sortare"]) !== "recommended" ||
    hasActiveFilters(parseListingFilters(query));
  return {
    title: page > 1 ? `${m.shop.title} - ${m.pagination.page(page)}` : m.shop.title,
    description: m.shop.metaDescription(storeName),
    alternates: { canonical: listingHref(SHOP_PATH, { page }) },
    robots: variant ? { index: false, follow: true } : undefined,
  };
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const chrome = await getStorefrontChrome();
  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <JsonLdScript
        data={breadcrumbList(loadEnv().APP_URL, [
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
        ])}
      />
      <Breadcrumbs items={[{ name: m.breadcrumbs.home, href: "/" }]} current={m.breadcrumbs.shop} />
      <h1 className="heading-display text-headline text-balance">{m.shop.title}</h1>
      <CatalogListing
        base={SHOP_PATH}
        scope={{}}
        params={query}
        layout={chrome.cardLayout}
        gridLabel={m.shop.title}
        emptyActions={
          <Link
            href="/"
            className="inline-flex h-12 items-center rounded-full bg-action px-6 font-semibold text-action-fg"
          >
            {m.breadcrumbs.home}
          </Link>
        }
      />
    </Container>
  );
}
