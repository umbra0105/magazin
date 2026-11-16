import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { X } from "lucide-react";
import {
  hasActiveFilters,
  hasNonCanonicalFilterParams,
  pageWindow,
  parseListingFilters,
  parseListingPage,
  parseListingSort,
  withoutFilter,
  type CardLayout,
  type ListingFilters,
  type ListingScope,
} from "@ecom/core";
import { StorefrontState } from "@ecom/ui";
import {
  getCatalogReader,
  getFacetsCached,
  getStorefrontFormat,
  listProductsCached,
} from "@/lib/storefront-catalog";
import { listingHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";
import { FilterPanel } from "./filter-panel";
import { ListingPagination, ListingSortLinks } from "./listing-controls";
import { ProductGrid } from "./product-grid";

const m = getMessages().storefront.catalog;

type Params = Record<string, string | string[] | undefined>;

/**
 * Lista de produse a oricărei pagini de catalog (categorie, magazin, marcă, colecție, căutare): filtre în adresă, panou
 * persistent pe calculator și «Filtrează» pe telefon, chip-uri eliminabile, sortare, grilă, paginare. O adresă cu forme de
 * formular (\`min_\`/\`max_\`, parametri repetați) sau cu filtre învechite se redirecționează la forma canonică; o pagină peste
 * capăt dă 404. Rezultatele și contorizările vin din cache-ul cu etichete al catalogului.
 */
export async function CatalogListing({
  base,
  scope,
  params,
  layout,
  gridLabel,
  query,
  relevance = false,
  emptyActions,
}: {
  base: string;
  scope: Omit<ListingScope, "filters">;
  params: Params;
  layout: CardLayout;
  gridLabel: string;
  /** Textul căutat (pagina de căutare); se păstrează în adresele filtrelor, sortării și paginii. */
  query?: string;
  /** Pagina de căutare: ordine după relevanță, fără pastilele de sortare. */
  relevance?: boolean;
  emptyActions?: React.ReactNode;
}) {
  const reader = getCatalogReader();
  const format = await getStorefrontFormat();
  const parsed = parseListingFilters(params);
  const filters = await reader.sanitizeFilters(parsed);
  const sort = parseListingSort(params["sortare"]);
  const requestedPage = parseListingPage(params["pagina"]);

  const canonicalOptions = {
    ...(query ? { query } : {}),
    filters,
    sort,
    page: requestedPage,
  };
  const sanitizedAway =
    JSON.stringify(parsed) !== JSON.stringify(filters) && hasActiveFilters(parsed);
  if (hasNonCanonicalFilterParams(params) || sanitizedAway) {
    redirect(listingHref(base, canonicalOptions));
  }

  const fullScope = { ...scope, filters };
  const orderBy = relevance ? "relevance" : sort;
  const first = await listProductsCached(fullScope, orderBy, 0, 1, format);
  const window = pageWindow(requestedPage, first.total, format.productsPerPage);
  if (window.outOfRange) notFound();
  const [facets, list, names] = await Promise.all([
    getFacetsCached(fullScope),
    listProductsCached(fullScope, orderBy, window.offset, format.productsPerPage, format),
    reader.describeFilters(filters),
  ]);

  const active = hasActiveFilters(filters);
  const activeCount =
    filters.brands.length +
    Object.keys(filters.ranges).length +
    Object.values(filters.options).flat().length;
  const showPanel =
    active || facets.brands.length > 1 || facets.ranges.length > 0 || facets.options.length > 0;

  const hidden = [
    ...(query ? [{ name: "q", value: query }] : []),
    ...(!relevance && sort !== "recommended" ? [{ name: "sortare", value: sort }] : []),
  ];
  const hrefFor = (next: ListingFilters) =>
    listingHref(base, { ...(query ? { query } : {}), filters: next, sort });
  const clearHref = hrefFor({ brands: [], ranges: {}, options: {} });

  const rangeText = (code: string): string => {
    const range = filters.ranges[code];
    const meta = facets.ranges.find((r) => r.code === code);
    const unit = meta?.unit ? ` ${meta.unit}` : "";
    if (!range) return "";
    if (range.min !== null && range.max !== null) return `${range.min}–${range.max}${unit}`;
    return range.min !== null ? `≥ ${range.min}${unit}` : `≤ ${range.max}${unit}`;
  };

  const chips: { label: string; href: string }[] = [
    ...filters.brands.map((slug) => ({
      label: names.brands[slug] ?? slug,
      href: hrefFor(withoutFilter(filters, { kind: "brand", slug })),
    })),
    ...Object.keys(filters.ranges).map((code) => ({
      label: m.filters.rangeChip(
        facets.ranges.find((r) => r.code === code)?.name ?? code,
        rangeText(code),
      ),
      href: hrefFor(withoutFilter(filters, { kind: "range", code })),
    })),
    ...Object.entries(filters.options).flatMap(([code, ids]) =>
      ids.map((id) => ({
        label: m.filters.optionChip(
          facets.options.find((o) => o.code === code)?.name ?? code,
          names.options[code]?.[id] ?? id,
        ),
        href: hrefFor(withoutFilter(filters, { kind: "option", code, id })),
      })),
    ),
  ];

  const panel = (
    <FilterPanel
      action={base}
      facets={facets}
      hidden={hidden}
      clearHref={clearHref}
      hasActive={active}
    />
  );

  const results =
    list.items.length === 0 ? (
      <StorefrontState
        title={active ? m.filters.noResults.title : m.empty.title}
        description={active ? m.filters.noResults.description : m.empty.description}
        actions={
          active ? (
            <Link
              href={clearHref}
              className="inline-flex h-12 items-center rounded-full bg-action px-6 font-semibold text-action-fg"
            >
              {m.filters.clear}
            </Link>
          ) : (
            emptyActions
          )
        }
      />
    ) : (
      <>
        <ProductGrid
          products={list.items}
          format={format}
          layout={layout}
          label={gridLabel}
          narrow={showPanel}
        />
        <ListingPagination
          base={base}
          sort={sort}
          page={window.page}
          pageCount={window.pageCount}
          filters={filters}
          {...(query ? { query } : {})}
        />
      </>
    );

  return (
    <div className="flex flex-col gap-6" data-listing data-total={list.total}>
      <p className="text-sm text-ink-secondary" data-total-label>
        {m.total(list.total)}
      </p>
      {chips.length > 0 ? (
        <ul
          aria-label={m.filters.active}
          className="flex flex-wrap items-center gap-2"
          data-filter-chips
        >
          {chips.map((chip) => (
            <li key={chip.label + chip.href}>
              <Link
                href={chip.href}
                aria-label={m.filters.remove(chip.label)}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-card px-4 text-sm font-medium transition-colors duration-(--motion) hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {chip.label}
                <X aria-hidden="true" className="size-4" />
              </Link>
            </li>
          ))}
          <li>
            <Link
              href={clearHref}
              className="inline-flex min-h-11 items-center rounded-full px-3 text-sm underline underline-offset-2 hover:no-underline"
            >
              {m.filters.clear}
            </Link>
          </li>
        </ul>
      ) : null}
      <div className={showPanel ? "lg:grid lg:grid-cols-12 lg:items-start lg:gap-10" : ""}>
        {showPanel ? (
          <aside
            aria-label={m.filters.title}
            className="hidden lg:col-span-3 lg:block"
            data-filter-panel
          >
            {panel}
          </aside>
        ) : null}
        <div className={showPanel ? "flex flex-col gap-6 lg:col-span-9" : "flex flex-col gap-6"}>
          {showPanel ? (
            <details className="rounded-card bg-card lg:hidden" data-filter-sheet>
              <summary className="flex min-h-12 cursor-pointer items-center px-5 font-semibold">
                {m.filters.openSheet(activeCount)}
              </summary>
              <div className="px-5 pb-6 pt-2">{panel}</div>
            </details>
          ) : null}
          {relevance ? null : (
            <ListingSortLinks
              base={base}
              current={sort}
              filters={filters}
              {...(query ? { query } : {})}
            />
          )}
          {results}
        </div>
      </div>
    </div>
  );
}
