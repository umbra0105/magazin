import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@ecom/core";
import { DomainError, pluralRo } from "@ecom/shared";
import { TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { AdjustPointsForm } from "@/components/admin/loyalty/adjust-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getLoyaltyAdminService } from "@/lib/loyalty-admin";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty;
const text = m.customer;

export const metadata: Metadata = { title: m.list.title };
export const dynamic = "force-dynamic";

const points = (count: number) => pluralRo(count, "punct", "puncte", "de puncte");

/**
 * Fișa de puncte a unui client (Faza 15b): sold, puncte în așteptare, istoric (cu motivul ajustărilor) și ajustarea manuală.
 * Cere `loyalty.view`; formularul apare doar cu `loyalty.adjust` (verificat din nou pe server la trimitere).
 */
export default async function LoyaltyCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "loyalty.view", feature: "loyalty" });
  const { id } = await params;
  const customer = await getLoyaltyAdminService()
    .customer(subject, id)
    .catch((error: unknown) => {
      if (error instanceof DomainError && error.code === "VALIDATION_ERROR") return null;
      throw error;
    });
  if (!customer) notFound();
  const regional = await getSettings().getGroup("regional");
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);
  const canAdjust = can(subject, "loyalty.adjust");
  return (
    <div className="flex max-w-5xl flex-col gap-6" data-loyalty-customer>
      <Link href="/admin/clienti/puncte" className="text-body underline">
        {text.back}
      </Link>
      <PageHeader
        title={customer.name}
        description={customer.email}
        notes={[
          customer.earns ? text.earns : text.noEarn,
          ...(canAdjust ? [] : [m.adjust.readOnly]),
        ]}
      />
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-subtle p-4">
          <dt className="text-label text-ink-secondary">{text.balance}</dt>
          <dd className="text-title tabular-nums" data-loyalty-balance>
            {customer.balance.toLocaleString("ro-RO")}
          </dd>
        </div>
        <div className="rounded-lg bg-surface-subtle p-4">
          <dt className="text-label text-ink-secondary">{text.spendable}</dt>
          <dd className="text-title tabular-nums" data-loyalty-spendable>
            {customer.spendable.toLocaleString("ro-RO")}
          </dd>
        </div>
        <div className="rounded-lg bg-surface-subtle p-4">
          <dt className="text-label text-ink-secondary">{text.value}</dt>
          <dd className="text-title tabular-nums">
            {formatMoney(customer.valueMinor, regional.currency, regional.locale)}
          </dd>
        </div>
      </dl>
      {customer.nextExpiry ? (
        <p className="text-body">
          {text.nextExpiry(points(customer.nextExpiry.points), when(customer.nextExpiry.expiresAt))}
        </p>
      ) : null}

      {canAdjust ? <AdjustPointsForm customerId={customer.id} /> : null}

      <section aria-labelledby="loyalty-pending" className="flex flex-col gap-2">
        <h2 id="loyalty-pending" className="text-section">
          {text.pendingTitle}
        </h2>
        {customer.pending.length === 0 ? (
          <p className="text-body text-ink-secondary">{text.pendingNone}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-body">
            {customer.pending.map((row) => (
              <li key={row.orderId}>
                <Link href={`/admin/comenzi/${row.orderId}`} className="underline">
                  {text.pendingRow(points(row.points), row.orderNumber, when(row.availableAt))}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="loyalty-history" className="flex flex-col gap-2">
        <h2 id="loyalty-history" className="text-section">
          {text.historyTitle}
        </h2>
        {customer.history.length === 0 ? (
          <p className="text-body text-ink-secondary">{text.historyEmpty}</p>
        ) : (
          <Table stacked aria-label={text.historyTitle}>
            <THead>
              <Tr>
                <Th>{text.columns.date}</Th>
                <Th>{text.columns.what}</Th>
                <Th>{text.columns.order}</Th>
                <Th numeric>{text.columns.points}</Th>
                <Th numeric>{text.columns.balance}</Th>
                <Th>{text.columns.reason}</Th>
              </Tr>
            </THead>
            <TBody>
              {customer.history.map((row) => (
                <Tr key={row.id} data-loyalty-row={row.type}>
                  <Td>{when(row.createdAt)}</Td>
                  <Td>{text.types[row.type] ?? row.type}</Td>
                  <Td>
                    {row.orderId && row.orderNumber ? (
                      <Link href={`/admin/comenzi/${row.orderId}`} className="underline">
                        {row.orderNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td numeric>{row.points > 0 ? `+${row.points}` : row.points}</Td>
                  <Td numeric>{row.balanceAfter}</Td>
                  <Td>{row.reason ?? "—"}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
