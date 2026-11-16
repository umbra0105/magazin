import Link from "next/link";
import { LISTING_SORTS, type ListingSort } from "@ecom/core";
import { listingHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

const PILL =
  "inline-flex h-11 items-center rounded-full px-4 text-sm font-medium transition-colors duration-(--motion) " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

/**
 * Sortarea ca legături (merge și fără JavaScript, fără `<select>` nativ): fiecare legătură duce la prima pagină cu sortarea
 * aleasă. Adresele cu `?sortare=…` sunt `noindex` (pagina o declară), iar canonicul rămâne lista fără parametri.
 */
export function ListingSortLinks({ base, current }: { base: string; current: ListingSort }) {
  return (
    <nav aria-label={m.sort.label} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-secondary">{m.sort.label}</span>
      {LISTING_SORTS.map((sort) => {
        const active = sort === current;
        return (
          <Link
            key={sort}
            href={listingHref(base, { sort })}
            rel="nofollow"
            {...(active ? { "aria-current": "true" as const } : {})}
            className={`${PILL} ${active ? "bg-action text-action-fg" : "bg-card text-ink hover:bg-card-hover"}`}
          >
            {m.sort[sort]}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Paginarea cu legături reale `<a href>` și `rel="prev"` / `rel="next"` (docs/19 §1: fiecare pagină are canonical
 * auto-referențial, iar legăturile către pagina următoare și anterioară există în HTML-ul de pe server).
 */
export function ListingPagination({
  base,
  sort,
  page,
  pageCount,
}: {
  base: string;
  sort: ListingSort;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;
  const link = (target: number) => listingHref(base, { sort, page: target });
  return (
    <nav
      aria-label={m.pagination.label}
      className="flex flex-wrap items-center justify-between gap-4"
    >
      {page > 1 ? (
        <Link
          href={link(page - 1)}
          rel="prev"
          className={`${PILL} bg-card text-ink hover:bg-card-hover`}
        >
          {m.pagination.previous}
        </Link>
      ) : (
        <span />
      )}
      <p className="text-sm text-ink-secondary">{m.pagination.current(page, pageCount)}</p>
      {page < pageCount ? (
        <Link
          href={link(page + 1)}
          rel="next"
          className={`${PILL} bg-card text-ink hover:bg-card-hover`}
        >
          {m.pagination.next}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
