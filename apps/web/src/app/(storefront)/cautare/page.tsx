import type { Metadata } from "next";
import Link from "next/link";
import { isSearchable, normalizeSearchText } from "@ecom/core";
import { Container, StorefrontState } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import { CatalogListing } from "@/components/storefront/catalog/catalog-listing";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { SEARCH_PATH } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

type SearchParams = Record<string, string | string[] | undefined>;

const queryOf = (params: SearchParams): string => {
  const raw = params["q"];
  return (Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")).trim().slice(0, 80);
};

/** Căutarea internă NU se indexează (docs/19 §1): `noindex`, fără canonical către o listă cu parametri. */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const q = queryOf(await searchParams);
  return {
    title: q ? m.search.title(q) : m.search.metaTitle,
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = queryOf(params);
  const chrome = await getStorefrontChrome();
  const searchable = isSearchable(q);

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <Breadcrumbs items={[{ name: m.breadcrumbs.home, href: "/" }]} current={m.search.heading} />
      <h1 className="heading-display text-headline text-balance">
        {q ? m.search.title(q) : m.search.heading}
      </h1>
      {searchable ? (
        <CatalogListing
          base={SEARCH_PATH}
          scope={{ search: normalizeSearchText(q) }}
          params={params}
          query={q}
          relevance
          layout={chrome.cardLayout}
          gridLabel={m.search.title(q)}
          emptyActions={
            <Link
              href="/magazin"
              className="inline-flex h-12 items-center rounded-full bg-action px-6 font-semibold text-action-fg"
            >
              {m.empty.action}
            </Link>
          }
        />
      ) : (
        <StorefrontState title={m.search.heading} description={m.search.tooShort} />
      )}
    </Container>
  );
}
