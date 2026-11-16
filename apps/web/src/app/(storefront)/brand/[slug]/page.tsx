import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import {
  hasActiveFilters,
  parseListingFilters,
  parseListingPage,
  parseListingSort,
} from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { Container, StoreImage } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import { CatalogListing } from "@/components/storefront/catalog/catalog-listing";
import { JsonLdScript } from "@/components/storefront/json-ld";
import { getBrandCached, getCatalogReader } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { breadcrumbList } from "@/lib/structured-data";
import { SHOP_PATH, brandHref, listingHref } from "@/lib/storefront-urls";
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
  const brand = await getBrandCached(slug.toLowerCase());
  if (!brand) return {};
  const { storeName } = await getStorefrontChrome();
  const page = parseListingPage(query["pagina"]);
  const variant =
    parseListingSort(query["sortare"]) !== "recommended" ||
    hasActiveFilters(parseListingFilters(query));
  const title = brand.seoTitle || brand.name;
  return {
    title: page > 1 ? `${title} - ${m.pagination.page(page)}` : title,
    description:
      brand.seoDescription ||
      brand.description?.slice(0, 160) ||
      m.brandPage.metaDescription(brand.name, storeName),
    alternates: { canonical: listingHref(brandHref(brand.slug), { page }) },
    robots: variant ? { index: false, follow: true } : undefined,
  };
}

export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const resolved = await getCatalogReader().resolveBrand(slug);
  if (resolved.kind === "missing" || !resolved.canonical) notFound();
  if (resolved.kind === "redirect") {
    const keep = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        keep.append(name, item);
      }
    }
    const text = keep.toString();
    permanentRedirect(`${brandHref(resolved.canonical)}${text ? `?${text}` : ""}`);
  }
  const [brand, chrome] = await Promise.all([
    getBrandCached(resolved.canonical),
    getStorefrontChrome(),
  ]);
  if (!brand) notFound();

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <JsonLdScript
        data={breadcrumbList(loadEnv().APP_URL, [
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
          { name: brand.name, href: brandHref(brand.slug) },
        ])}
      />
      <Breadcrumbs
        items={[
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
        ]}
        current={brand.name}
      />
      <header className="flex flex-col gap-3">
        {brand.logo ? (
          <StoreImage
            src={brand.logo.src}
            alt={brand.logo.alt}
            width={brand.logo.width}
            height={brand.logo.height}
            priority
            className="h-12 w-auto max-w-48 object-contain object-left"
          />
        ) : null}
        <h1 className="heading-display text-headline text-balance">
          {m.brandPage.title(brand.name)}
        </h1>
        {brand.description ? (
          <p className="max-w-3xl whitespace-pre-line text-lede text-ink-secondary">
            {brand.description}
          </p>
        ) : null}
      </header>
      <CatalogListing
        base={brandHref(brand.slug)}
        scope={{ brandSlug: brand.slug }}
        params={query}
        layout={chrome.cardLayout}
        gridLabel={brand.name}
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
