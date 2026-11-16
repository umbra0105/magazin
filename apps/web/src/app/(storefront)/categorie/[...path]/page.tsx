import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { parseListingPage, parseListingSort, pageWindow } from "@ecom/core";
import { Container, StorefrontState, StoreButton } from "@ecom/ui";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import {
  ListingPagination,
  ListingSortLinks,
} from "@/components/storefront/catalog/listing-controls";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import {
  getCatalogReader,
  getCategoryCached,
  getStorefrontFormat,
  listProductsCached,
} from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { SHOP_PATH, categoryHref, listingHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";
import Link from "next/link";

const m = getMessages().storefront.catalog;

// Pagina citește `searchParams` (sortare, pagină), deci e randată la cerere; datele ei vin din cache-ul cu etichete al catalogului.

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
  const sorted = parseListingSort(query["sortare"]) !== "recommended";
  const title = category.seoTitle || category.name;
  return {
    title: page > 1 ? `${title} - ${m.pagination.page(page)}` : title,
    description: category.seoDescription || category.description?.slice(0, 160) || undefined,
    alternates: { canonical: listingHref(categoryHref(category.path), { page }) },
    // sortările sunt aceeași listă în altă ordine: nu se indexează (docs/19 §1); paginile se indexează, cu canonical propriu
    robots: sorted ? { index: false, follow: true } : undefined,
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
  // O singură adresă per categorie: altă scriere sau o cale veche duc (301) la cea curentă, cu sortarea și pagina păstrate.
  if (resolved.kind === "redirect") {
    permanentRedirect(
      listingHref(categoryHref(resolved.canonical), {
        sort: parseListingSort(query["sortare"]),
        page: parseListingPage(query["pagina"]),
      }),
    );
  }

  const [category, chrome, format] = await Promise.all([
    getCategoryCached(resolved.canonical),
    getStorefrontChrome(),
    getStorefrontFormat(),
  ]);
  if (!category) notFound();

  const sort = parseListingSort(query["sortare"]);
  const requestedPage = parseListingPage(query["pagina"]);
  const first = await listProductsCached({ categoryPath: category.path }, sort, 0, 1, format);
  const window = pageWindow(requestedPage, first.total, format.productsPerPage);
  // o pagină peste capăt nu se «repară»: ar crea adrese multiple cu același conținut
  if (window.outOfRange) notFound();
  const { items } = await listProductsCached(
    { categoryPath: category.path },
    sort,
    window.offset,
    format.productsPerPage,
    format,
  );

  const base = categoryHref(category.path);
  const node = findNode(chrome.menu, base);
  const crumbs = category.trail
    .slice(0, -1)
    .map((c) => ({ name: c.name, href: categoryHref(c.path) }));

  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12">
      <Breadcrumbs
        items={[
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
          ...crumbs,
        ]}
        current={category.name}
      />
      <header className="flex flex-col gap-3">
        <h1 className="heading-display text-headline text-balance">{category.name}</h1>
        {category.description ? (
          <p className="max-w-3xl whitespace-pre-line text-lede text-ink-secondary">
            {category.description}
          </p>
        ) : null}
        <p className="text-sm text-ink-secondary">{m.total(first.total)}</p>
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

      {items.length === 0 ? (
        <StorefrontState
          title={m.empty.title}
          description={m.empty.description}
          actions={
            <Link href={SHOP_PATH}>
              <StoreButton>{m.empty.action}</StoreButton>
            </Link>
          }
        />
      ) : (
        <>
          <ListingSortLinks base={base} current={sort} />
          <ProductGrid
            products={items}
            format={format}
            layout={chrome.cardLayout}
            label={category.name}
          />
          <ListingPagination
            base={base}
            sort={sort}
            page={window.page}
            pageCount={window.pageCount}
          />
        </>
      )}
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
