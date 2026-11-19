import type { Metadata } from "next";
import Link from "next/link";
import { can, INSTALLATION_STATUSES, listAdminOrders } from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  Badge,
  EmptyState,
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
import { InstallationStatusForm } from "@/components/admin/orders/order-panels";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

export const metadata: Metadata = { title: t.install.title };
export const dynamic = "force-dynamic";

/**
 * Cererile de instalare (docs/15 §4): comenzile care au cerut ofertă pentru instalare, cu starea de urmărire (cerută, contactat,
 * programată, făcută, refuzată). Cere `orders.read` și flag-ul `installationRequests`; schimbarea stării cere `orders.write` și nu
 * atinge totalul, stocul sau starea comenzii.
 */
export default async function InstallRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ vedere?: string }>;
}) {
  const subject = await requireAdmin({
    permission: "orders.read",
    feature: "installationRequests",
  });
  const { vedere } = await searchParams;
  const open = vedere !== "toate";
  const regional = await getSettings().getGroup("regional");
  const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
  const statuses = open ? ["requested", "contacted", "scheduled"] : [...INSTALLATION_STATUSES];
  const list = await listAdminOrders(
    getDb(),
    { installation: statuses, pageSize: 100, sort: "placed_desc" },
    { pii },
  );
  const openCount = open
    ? list.total
    : (
        await listAdminOrders(
          getDb(),
          { installation: ["requested", "contacted", "scheduled"], pageSize: 10 },
          { pii },
        )
      ).total;
  const canWrite = can(subject, "orders.write");
  const options = INSTALLATION_STATUSES.map((value) => ({
    value,
    label: t.installationStatuses[value] ?? value,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.install.title} count={list.total} description={t.install.description} />
      <nav aria-label={t.install.title} className={TAB_LIST_CLASS}>
        <Link
          href="/admin/comenzi/cereri-instalare"
          aria-current={open ? "page" : undefined}
          className={tabClass(open)}
        >
          {t.install.open(openCount)}
        </Link>
        <Link
          href="/admin/comenzi/cereri-instalare?vedere=toate"
          aria-current={!open ? "page" : undefined}
          className={tabClass(!open)}
        >
          {t.install.all}
        </Link>
      </nav>
      {list.rows.length === 0 ? (
        <EmptyState title={t.install.empty} />
      ) : (
        <Table stacked aria-label={t.install.title}>
          <THead>
            <Tr>
              <Th priority="primary">{t.install.columns.order}</Th>
              <Th priority="secondary">{t.install.columns.customer}</Th>
              <Th priority="primary">{t.install.columns.status}</Th>
              <Th priority="tertiary">{t.install.columns.date}</Th>
              <Th priority="primary">
                <span className="sr-only">{t.columns.actions}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {list.rows.map((row) => (
              <Tr key={row.id} data-install-row={row.number}>
                <RowHeader stack="title" className="font-medium">
                  <Link
                    href={`/admin/comenzi/${row.id}`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {row.number}
                  </Link>
                </RowHeader>
                <Td priority="secondary">
                  {row.customerName ?? <span className="text-ink-secondary">{t.piiHidden}</span>}
                </Td>
                <Td priority="primary">
                  <Badge
                    variant={
                      row.installationStatus === "done"
                        ? "success"
                        : row.installationStatus === "declined"
                          ? "neutral"
                          : "warning"
                    }
                    dot
                  >
                    {t.installationStatuses[row.installationStatus ?? ""] ?? row.installationStatus}
                  </Badge>
                </Td>
                <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                  {formatDateTime(row.placedAt, regional.locale, regional.timezone)}
                </Td>
                <Td priority="primary" stack="actions">
                  {canWrite && row.installationStatus && (
                    <InstallationStatusForm
                      orderId={row.id}
                      current={row.installationStatus}
                      statuses={options}
                    />
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
