import type { Metadata } from "next";
import Link from "next/link";
import { can, listOffers, type OfferListView } from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  Badge,
  EmptyState,
  Pagination,
  RowHeader,
  TAB_LIST_CLASS,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  tabClass,
} from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;
const o = t.offers;

export const metadata: Metadata = { title: o.title };
export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  active: "info",
  converted: "success",
  expired: "neutral",
  stale: "warning",
  cancelled: "neutral",
};

/**
 * Lista ofertelor de plată (macheta 1 din docs/17 §4): vederile «Deschise» (active sau învechite) și «Toate», stări ca pastile cu
 * text, paginare, legătură spre comanda rezultată. Cere `orders.offers`; contactul clientului apare doar cu drept de date personale.
 */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ vedere?: string; pagina?: string }>;
}) {
  const subject = await requireAdmin({ permission: "orders.offers" });
  const { vedere, pagina } = await searchParams;
  const view: OfferListView = vedere === "toate" ? "all" : "open";
  const page = Math.max(1, Number(pagina) || 1);
  const regional = await getSettings().getGroup("regional");
  const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
  const list = await listOffers(getDb(), { view, page, pageSize: 25 }, { pii });
  const pageCount = Math.max(1, Math.ceil(list.total / 25));
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (view === "all") params.set("vedere", "toate");
    if (target > 1) params.set("pagina", String(target));
    const query = params.toString();
    return query ? `/admin/comenzi/oferte?${query}` : "/admin/comenzi/oferte";
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={o.title} count={list.total} description={o.description} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={o.views.nav} className={TAB_LIST_CLASS}>
          <Link
            href="/admin/comenzi/oferte"
            aria-current={view === "open" ? "page" : undefined}
            className={tabClass(view === "open")}
          >
            {o.views.open}
          </Link>
          <Link
            href="/admin/comenzi/oferte?vedere=toate"
            aria-current={view === "all" ? "page" : undefined}
            className={tabClass(view === "all")}
          >
            {o.views.all}
          </Link>
        </nav>
        <Link
          href="/admin/comenzi/oferte/nou"
          className="inline-flex h-(--control-h) items-center rounded-md bg-brand px-4 text-brand-fg"
          data-offer-new
        >
          {o.newOffer}
        </Link>
      </div>
      {list.rows.length === 0 ? (
        <EmptyState title={o.empty} />
      ) : (
        <Table stacked aria-label={o.title}>
          <THead>
            <Tr>
              <Th priority="primary">{o.columns.number}</Th>
              <Th priority="secondary">{o.columns.customer}</Th>
              <Th priority="primary">{o.columns.total}</Th>
              <Th priority="primary">{o.columns.status}</Th>
              <Th priority="tertiary">{o.columns.validUntil}</Th>
              <Th priority="tertiary">{o.columns.creator}</Th>
              <Th priority="secondary">{o.columns.order}</Th>
            </Tr>
          </THead>
          <TBody>
            {list.rows.map((row) => (
              <Tr key={row.id} data-offer-row={row.number}>
                <RowHeader stack="title" className="font-medium">
                  <Link
                    href={`/admin/comenzi/oferte/${row.id}`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {row.number}
                  </Link>
                </RowHeader>
                <Td priority="secondary">
                  {row.customerName ?? <span className="text-ink-secondary">{o.piiHidden}</span>}
                </Td>
                <Td priority="primary" className="whitespace-nowrap">
                  {money(row.totalMinor)}
                </Td>
                <Td priority="primary">
                  <Badge variant={TONE[row.status] ?? "neutral"} dot>
                    {o.statuses[row.status] ?? row.status}
                  </Badge>
                </Td>
                <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                  {formatDateTime(row.expiresAt, regional.locale, regional.timezone)}
                </Td>
                <Td priority="tertiary" className="text-ink-secondary">
                  {row.creatorLabel}
                </Td>
                <Td priority="secondary">
                  {row.convertedOrderId ? (
                    <Link
                      href={`/admin/comenzi/${row.convertedOrderId}`}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {o.columns.order}
                    </Link>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {list.total > 25 && (
        <Pagination
          label={t.pagination.label}
          page={page}
          pageCount={pageCount}
          hrefFor={pageHref}
          previousLabel={t.pagination.previous}
          nextLabel={t.pagination.next}
          pageLabel={(target) => `Pagina ${target}`}
          summary={t.pagination.summary}
          renderLink={({ children, ...props }) => (
            <Link {...props} href={props.href}>
              {children}
            </Link>
          )}
        />
      )}
    </div>
  );
}
