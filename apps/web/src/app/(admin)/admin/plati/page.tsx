import type { Metadata } from "next";
import Link from "next/link";
import { listPayments, paymentCounters, type PaymentListView } from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  Badge,
  EmptyState,
  RowHeader,
  TAB_LIST_CLASS,
  TBody,
  Table,
  Td,
  Th,
  THead,
  Tr,
  tabClass,
} from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.payments;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const VIEWS: ReadonlyArray<{ id: PaymentListView; param: string }> = [
  { id: "all", param: "toate" },
  { id: "attention", param: "atentie" },
  { id: "refunds", param: "rambursari" },
];

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning",
  paid: "success",
  failed: "danger",
  cancelled: "neutral",
  refunded: "info",
};

/**
 * Plățile cu cardul (Faza 10): lista cu vederile «Toate», «Necesită atenție» și «Rambursări». Cere `payments.read`; rambursarea
 * din detaliu cere `payments.refund`. Lista comenzilor și detaliul comenzii vin în Faza 11, care integrează aceste ecrane.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ vedere?: string; pagina?: string }>;
}) {
  await requireAdmin({ permission: "payments.read" });
  const query = await searchParams;
  const view = VIEWS.find((v) => v.param === query.vedere) ?? VIEWS[0]!;
  const page = Math.max(1, Number.parseInt(query.pagina ?? "1", 10) || 1);
  const db = getDb();
  const [list, counters, regional] = await Promise.all([
    listPayments(db, { view: view.id, page, pageSize: PAGE_SIZE }),
    paymentCounters(db, new Date()),
    getSettings().getGroup("regional"),
  ]);
  const pageCount = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const href = (param: string, p = 1) =>
    `/admin/plati?vedere=${param}${p > 1 ? `&pagina=${p}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} count={list.total} description={m.description} />

      <nav aria-label={m.title} className={TAB_LIST_CLASS}>
        {VIEWS.map((item) => (
          <Link
            key={item.id}
            href={href(item.param)}
            aria-current={item.id === view.id ? "page" : undefined}
            className={tabClass(item.id === view.id)}
          >
            {item.id === "attention" ? m.views.attention(counters.attention) : m.views[item.id]}
          </Link>
        ))}
      </nav>

      {list.rows.length === 0 ? (
        <EmptyState title={m.empty} />
      ) : (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th priority="primary">{m.columns.order}</Th>
              <Th priority="primary" numeric>
                {m.columns.amount}
              </Th>
              <Th priority="primary">{m.columns.status}</Th>
              <Th priority="secondary">{m.columns.provider}</Th>
              <Th priority="secondary" numeric>
                {m.columns.refunded}
              </Th>
              <Th priority="tertiary">{m.columns.date}</Th>
              <Th priority="primary">
                <span className="sr-only">{m.columns.actions}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {list.rows.map((row) => (
              <Tr key={row.id}>
                <RowHeader stack="title" className="font-medium">
                  <Link
                    href={`/admin/plati/${row.id}`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {row.orderNumber}
                  </Link>
                  <span className="block text-label font-normal text-ink-secondary">
                    {m.attempt(row.attemptNo)}
                  </span>
                </RowHeader>
                <Td priority="primary" numeric className="whitespace-nowrap tabular-nums">
                  {money(row.amountMinor)}
                </Td>
                <Td priority="primary">
                  <span className="flex flex-wrap gap-1">
                    <Badge variant={STATUS_TONE[row.status] ?? "neutral"} dot>
                      {m.paymentStatus[row.status] ?? row.status}
                    </Badge>
                    {row.attentionReason && (
                      <Badge variant="warning">
                        {m.attention[row.attentionReason]?.label ?? m.attentionTitle}
                      </Badge>
                    )}
                  </span>
                </Td>
                <Td priority="secondary" className="whitespace-nowrap">
                  {m.providers[row.provider] ?? row.provider}
                  {row.mode && row.mode !== "live" ? ` (${m.modes[row.mode] ?? row.mode})` : ""}
                </Td>
                <Td priority="secondary" numeric className="whitespace-nowrap tabular-nums">
                  {row.refundCommittedMinor > 0 ? money(row.refundCommittedMinor) : "—"}
                </Td>
                <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                  {formatDateTime(row.createdAt, regional.locale, regional.timezone)}
                </Td>
                <Td priority="primary" stack="actions">
                  <Link
                    href={`/admin/plati/${row.id}`}
                    className="inline-flex min-h-11 items-center text-link underline-offset-2 hover:underline md:min-h-0"
                  >
                    {m.view}
                  </Link>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {pageCount > 1 && (
        <nav aria-label="Paginare" className="flex items-center justify-between gap-3 text-body">
          {page > 1 ? (
            <Link
              className="text-link underline-offset-2 hover:underline"
              href={href(view.param, page - 1)}
            >
              Înapoi
            </Link>
          ) : (
            <span className="text-ink-disabled">Înapoi</span>
          )}
          <span className="tabular-nums text-ink-secondary">{`Pagina ${page} din ${pageCount}`}</span>
          {page < pageCount ? (
            <Link
              className="text-link underline-offset-2 hover:underline"
              href={href(view.param, page + 1)}
            >
              Înainte
            </Link>
          ) : (
            <span className="text-ink-disabled">Înainte</span>
          )}
        </nav>
      )}
    </div>
  );
}
