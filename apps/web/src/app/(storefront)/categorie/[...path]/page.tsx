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
import { Container } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import { CatalogListing } from "@/components/storefront/catalog/catalog-listing";
import { JsonLdScript } from "@/components/storefront/json-ld";
import { getCatalogReader, getCategoryCached, listProductsCached } from "@/lib/storefront-catalog";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { breadcrumbList, itemList } from "@/lib/structured-data";
import { SHOP_PATH, categoryHref, listingHref, productHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

// Pagina citește `searchParams` (filtre, sortare, pagină), deci e randată la cerere; datele ei vin din cache-ul cu etichete al catalogului.

type Params = { path: string[] };
type SearchParams = Record<string, string | string[] | undefined>;

const pathOf = (segments: readonly string[]): string =>
  segments.map((segment) => decodeURIComponent(segment)).join("/");

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const path = pathOf((await params).path);
  const query = await searchParams;
  const category = await getCategoryCached(path.toLowerCase());
  if (!category) return {};
  const { storeName } = await getStorefrontChrome();
  const page = parseListingPage(query["pagina"]);
  // sortările și filtrele sunt aceeași listă în alt fel: nu se indexează (docs/19 §1); paginile se indexează, cu canonical propriu
  const variant =
    parseListingSort(query["sortare"]) !== "recommended" ||
    hasActiveFilters(parseListingFilters(query));
  const title = category.seoTitle || category.name;
  return {
    title: page > 1 ? `${title} - ${m.pagination.page(page)}` : title,
    description: category.seoDescription || category.description?.slice(0, 160) || undefined,
    alternates: { canonical: listingHref(categoryHref(category.path), { page }) },
    robots: variant ? { index: false, follow: true } : undefined,
    openGraph: { siteName: storeName, title },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const path = pathOf((await params).path);
  const query = await searchParams;
  const reader = getCatalogReader();

  const resolved = await reader.resolveCategory(path);
  if (resolved.kind === "missing" || !resolved.canonical) notFound();
  // O singură adresă per categorie: altă scriere sau o cale veche duc (308) la cea curentă, cu parametrii păstrați.
  if (resolved.kind === "redirect") {
    const keep = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        keep.append(name, item);
      }
    }
    const text = keep.toString();
    permanentRedirect(`${categoryHref(resolved.canonical)}${text ? `?${text}` : ""}`);
  }

  const [category, chrome, format] = await Promise.all([
    getCategoryCached(resolved.canonical),
    getStorefrontChrome(),
    getStorefrontFormat(),
  ]);
  if (!category) notFound();

  const base = categoryHref(category.path);
  const node = findNode(chrome.menu, base);
  const crumbs = category.trail
    .slice(0, -1)
    .map((c) => ({ name: c.name, href: categoryHref(c.path) }));
  const trail = [
    { name: m.breadcrumbs.home, href: "/" },
    { name: m.breadcrumbs.shop, href: SHOP_PATH },
    ...crumbs,
  ];
  const appUrl = loadEnv().APP_URL;
  const page = parseListingPage(query["pagina"]);
  const first = await listProductsCached(
    { categoryPath: category.path },
    "recommended",
    (page - 1) * format.productsPerPage,
    format.productsPerPage,
    format,
  );

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <JsonLdScript
        data={[
          breadcrumbList(appUrl, [...trail, { name: category.name, href: base }]),
          itemList(
            appUrl,
            first.items.map((item) => ({ name: item.title, href: productHref(item.slug) })),
            (page - 1) * format.productsPerPage,
          ),
        ]}
      />
      <Breadcrumbs items={trail} current={category.name} />
      <header className="flex flex-col gap-3">
        <h1 className="heading-display text-headline text-balance">{category.name}</h1>
        {category.description ? (
          <p className="max-w-3xl whitespace-pre-line text-lede text-ink-secondary">
            {category.description}
          </p>
        ) : null}
      </header>

      {node && node.children.length > 0 ? (
        <nav aria-label={m.subcategories} className="flex flex-wrap gap-2">
          {node.children.map((child) => (
            <Link
              key={child.id}
              href={child.href}
              className="inline-flex h-11 items-center rounded-full bg-card px-5 text-sm font-medium text-ink transition-colors duration-(--motion) hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {child.name}
            </Link>
          ))}
        </nav>
      ) : null}

      <CatalogListing
        base={base}
        scope={{ categoryPath: category.path }}
        params={query}
        layout={chrome.cardLayout}
        gridLabel={category.name}
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

function findNode(
  nodes: readonly { href: string; children: readonly unknown[] }[],
  href: string,
): {
  href: string;
  id: string;
  name: string;
  children: { id: string; name: string; href: string }[];
} | null {
  type Node = { href: string; id: string; name: string; children: Node[] };
  const walk = (list: readonly Node[]): Node | null => {
    for (const node of list) {
      if (node.href === href) return node;
      const inner = walk(node.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(nodes as unknown as Node[]);
}
