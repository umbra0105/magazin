import type { Metadata } from "next";
import Link from "next/link";
import { listEntitlements } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Badge, RowHeader, TBody, THead, Table, Td, Th, Tr, buttonVariants } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().digitalAdmin.list;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

const PAGE_SIZE = 25;

/**
 * «Acces digital» (Faza 14b): toate drepturile de acces ale clienților la produsele digitale, cu căutare după număr de comandă
 * sau email («lista pe client») și filtru de stare. Fiecare rând duce la comanda lui, unde sunt acțiunile și jurnalul de accesări.
 * Citire cu `digital.view`. Emailul clientului se vede doar cu `customers.read_pii`, ca în lista comenzilor.
 */
export default async function DigitalAccessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "digital.view" });
  const query = await searchParams;
  const q = one(query["q"]).trim().slice(0, 100);
  const statusParam = one(query["stare"]);
  const status = statusParam === "active" || statusParam === "revoked" ? statusParam : "all";
  const page = Math.max(1, Math.floor(Number(one(query["pagina"])) || 1));
  const regional = await getSettings().getGroup("regional");
  const showEmail = subject.permissions.has("customers.read_pii");

  const result = await listEntitlements(getDb(), {
    ...(q ? { query: q } : {}),
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const hrefFor = (next: { q?: string; stare?: string; pagina?: number }): string => {
    const params = new URLSearchParams();
    const nextQ = next.q ?? q;
    const nextStatus = next.stare ?? status;
    if (nextQ) params.set("q", nextQ);
    if (nextStatus !== "all") params.set("stare", nextStatus);
    if ((next.pagina ?? page) > 1) params.set("pagina", String(next.pagina ?? page));
    const text = params.toString();
    return text ? `?${text}` : "?";
  };

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader title={m.title} count={result.total} description={m.lede} />
      <form method="get" className="flex flex-wrap items-end gap-3" role="search">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="dg-q" className="text-label font-medium">
            {m.search}
          </label>
          <input
            id="dg-q"
            name="q"
            defaultValue={q}
            className="h-(--control-h) rounded-md border border-line-input bg-surface-page px-3 text-(length:--control-text)"
          />
        </div>
        {status !== "all" ? <input type="hidden" name="stare" value={status} /> : null}
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          {m.searchButton}
        </button>
      </form>
      <nav aria-label={m.title} className="flex flex-wrap gap-2">
        {(["all", "active", "revoked"] as const).map((key) => (
          <Link
            key={key}
            href={hrefFor({ stare: key, pagina: 1 })}
            aria-current={status === key ? "page" : undefined}
            className={buttonVariants({
              variant: status === key ? "default" : "outline",
              size: "sm",
            })}
          >
            {m.status[key]}
          </Link>
        ))}
      </nav>

      {result.rows.length === 0 ? (
        <p className="text-ink-secondary">{q || status !== "all" ? m.empty : m.emptyAll}</p>
      ) : (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th priority="primary">{m.columns.product}</Th>
              <Th priority="primary">{m.columns.order}</Th>
              <Th priority="secondary">{m.columns.customer}</Th>
              <Th priority="secondary">{m.columns.granted}</Th>
              <Th priority="tertiary">{m.columns.downloads}</Th>
              <Th priority="primary">{m.columns.status}</Th>
              <Th priority="detail">{m.columns.lastAccess}</Th>
            </Tr>
          </THead>
          <TBody>
            {result.rows.map((row) => (
              <Tr key={row.id}>
                <RowHeader stack="title">{row.productTitle}</RowHeader>
                <Td priority="primary">
                  <Link
                    href={`/admin/comenzi/${row.orderId}#digital-access`}
                    className="underline underline-offset-4"
                    title={m.open}
                  >
                    {row.orderNumber}
                  </Link>
                </Td>
                <Td priority="secondary">{showEmail ? row.customerEmail : "—"}</Td>
                <Td priority="secondary">
                  {formatDateTime(row.grantedAt, regional.locale, regional.timezone)}
                </Td>
                <Td priority="tertiary">
                  {row.maxDownloads === null
                    ? `${row.downloadCount} (${m.unlimited})`
                    : `${row.downloadCount} / ${row.maxDownloads}`}
                </Td>
                <Td priority="primary">
                  <Badge variant={row.revokedAt ? "danger" : "success"}>
                    {row.revokedAt
                      ? getMessages().digitalAdmin.order.revoked
                      : getMessages().digitalAdmin.order.active}
                  </Badge>
                </Td>
                <Td priority="detail">
                  {row.lastAccessAt
                    ? formatDateTime(row.lastAccessAt, regional.locale, regional.timezone)
                    : "—"}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {pages > 1 ? (
        <div className="flex items-center gap-3">
          {page > 1 ? (
            <Link
              href={hrefFor({ pagina: page - 1 })}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {m.previous}
            </Link>
          ) : null}
          <span className="text-label text-ink-secondary">{m.page(page, pages)}</span>
          {page < pages ? (
            <Link
              href={hrefFor({ pagina: page + 1 })}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {m.next}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
