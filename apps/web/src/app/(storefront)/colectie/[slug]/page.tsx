import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { getCollectionCached } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { breadcrumbList } from "@/lib/structured-data";
import { SHOP_PATH, collectionHref, listingHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const query = await searchParams;
  const collection = await getCollectionCached(slug.toLowerCase());
  if (!collection) return {};
  const page = parseListingPage(query["pagina"]);
  const variant =
    parseListingSort(query["sortare"]) !== "recommended" ||
    hasActiveFilters(parseListingFilters(query));
  const title = collection.seoTitle || collection.name;
  return {
    title: page > 1 ? `${title} - ${m.pagination.page(page)}` : title,
    description: collection.seoDescription || collection.description?.slice(0, 160) || undefined,
    alternates: { canonical: listingHref(collectionHref(collection.slug), { page }) },
    robots: variant ? { index: false, follow: true } : undefined,
  };
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const [collection, chrome] = await Promise.all([
    getCollectionCached(slug.toLowerCase()),
    getStorefrontChrome(),
  ]);
  if (!collection) notFound();
  // adresa canonică e cu litere mici
  const base = collectionHref(collection.slug);

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <JsonLdScript
        data={breadcrumbList(loadEnv().APP_URL, [
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
          { name: collection.name, href: base },
        ])}
      />
      <Breadcrumbs
        items={[
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
        ]}
        current={collection.name}
      />
      <header className="flex flex-col gap-3">
        <h1 className="heading-display text-headline text-balance">{collection.name}</h1>
        {collection.description ? (
          <p className="max-w-3xl whitespace-pre-line text-lede text-ink-secondary">
            {collection.description}
          </p>
        ) : null}
      </header>
      <CatalogListing
        base={base}
        scope={{ collectionId: collection.id }}
        params={query}
        layout={chrome.cardLayout}
        gridLabel={collection.name}
        emptyActions={
          <Link
            href={SHOP_PATH}
            className="inline-flex h-12 items-center rounded-full bg-action px-6 font-semibold text-action-fg"
          >
            {m.empty.action}
          </Link>
        }
      />
    </Container>
  );
}
