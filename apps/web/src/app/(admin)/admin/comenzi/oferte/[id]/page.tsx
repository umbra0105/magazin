import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getOfferDetail } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Badge, RowHeader, Section, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { CrumbLabel } from "@/components/admin/crumb-labels";
import { OfferDetailActions } from "@/components/admin/offers/offer-detail-actions";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const o = getMessages().admin.orders.offers;

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
 * Detaliul unei oferte: stare, client (doar cu drept de date personale), liniile și totalurile ÎNGHEȚATE, istoricul. Jetonul din
 * link nu se păstrează și nu se poate arăta aici: pentru un link nou există «Retrimite». Cere `orders.offers`.
 */
export default async function OfferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "orders.offers" });
  const { id } = await params;
  const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
  const offer = await getOfferDetail(getDb(), id, { pii });
  if (!offer) notFound();
  const regional = await getSettings().getGroup("regional");
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);

  return (
    <div className="flex flex-col gap-6" data-offer-detail={offer.number}>
      <CrumbLabel label={offer.number} />
      <PageHeader
        title={`${o.title}: ${offer.number}`}
        description={
          <span className="inline-flex items-center gap-2">
            <Badge variant={TONE[offer.status] ?? "neutral"} dot>
              {o.statuses[offer.status] ?? offer.status}
            </Badge>
            <span>
              {o.detail.validUntil} {when(offer.expiresAt)}
            </span>
          </span>
        }
      />
      {offer.status === "stale" && offer.staleReason && (
        <p role="note" className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
          {o.staleReasons[offer.staleReason] ?? offer.staleReason}. {o.detail.staleNote}
        </p>
      )}
      {offer.convertedOrder && (
        <p>
          {o.detail.convertedTo}:{" "}
          <Link
            href={`/admin/comenzi/${offer.convertedOrder.id}`}
            className="text-link underline-offset-2 hover:underline"
          >
            {offer.convertedOrder.number}
          </Link>
        </p>
      )}
      {offer.status === "active" && <OfferDetailActions offerId={offer.id} />}

      <Section id="customer" title={o.detail.customer}>
        {offer.customer ? (
          <dl className="grid gap-1 sm:grid-cols-2">
            <div>
              <dt className="text-label text-ink-secondary">{o.wizard.fullName}</dt>
              <dd>{offer.customer.fullName}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-secondary">{o.wizard.email}</dt>
              <dd>{offer.customer.email}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-secondary">{o.wizard.phone}</dt>
              <dd>{offer.customer.phone}</dd>
            </div>
            <div>
              <dt className="text-label text-ink-secondary">{o.detail.shipping}</dt>
              <dd>
                {offer.shippingKind === "pickup"
                  ? o.detail.pickup
                  : `${offer.customer.street}, ${offer.customer.localityName}, ${offer.customer.countyName}, ${offer.customer.postalCode}`}
              </dd>
            </div>
            {offer.customer.company && (
              <div>
                <dt className="text-label text-ink-secondary">{o.wizard.company}</dt>
                <dd>
                  {offer.customer.company.name}, {offer.customer.company.vatId}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-ink-secondary">{o.piiHidden}</p>
        )}
        <p className="mt-2 text-body text-ink-secondary">
          {o.detail.createdBy} {offer.creatorLabel}, {when(offer.createdAt)}.{" "}
          {offer.lastSentAt
            ? `${o.detail.lastSent}: ${when(offer.lastSentAt)}`
            : o.detail.neverSent}
        </p>
      </Section>

      <Section id="lines" title={o.detail.lines}>
        <Table stacked aria-label={o.detail.lines}>
          <THead>
            <Tr>
              <Th priority="primary">{o.wizard.lineColumns.product}</Th>
              <Th priority="primary">{o.wizard.lineColumns.quantity}</Th>
              <Th priority="secondary">{o.wizard.lineColumns.unitPrice}</Th>
              <Th priority="primary">{o.wizard.lineColumns.total}</Th>
            </Tr>
          </THead>
          <TBody>
            {offer.lines.map((line) => (
              <Tr key={line.sku}>
                <RowHeader stack="title">
                  {line.title}
                  <span className="block text-label text-ink-secondary">{line.sku}</span>
                </RowHeader>
                <Td priority="primary">
                  {line.quantity} {line.unitSymbol}
                </Td>
                <Td priority="secondary">{money(line.unitPriceMinor)}</Td>
                <Td priority="primary">{money(line.lineTotalMinor)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Section>

      <Section id="totals" title={o.detail.totals}>
        <dl className="flex max-w-sm flex-col gap-1">
          <div className="flex justify-between">
            <dt>{o.wizard.summaryProducts}</dt>
            <dd>{money(offer.subtotalMinor)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>{o.wizard.summaryShipping}</dt>
            <dd>{offer.shippingMinor === 0 ? o.wizard.free : money(offer.shippingMinor)}</dd>
          </div>
          <div className="flex justify-between text-ink-secondary">
            <dt>{o.wizard.summaryVat}</dt>
            <dd>{money(offer.taxMinor)}</dd>
          </div>
          <div className="flex justify-between border-t border-line-subtle pt-2 font-semibold">
            <dt>{o.wizard.summaryTotal}</dt>
            <dd>{money(offer.totalMinor)}</dd>
          </div>
        </dl>
      </Section>

      <Section id="history" title={o.detail.history}>
        <ol className="flex flex-col gap-2">
          {offer.events.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-3">
              <span className="text-ink-secondary">{when(event.createdAt)}</span>
              <span>{o.detail.events[event.type] ?? event.message}</span>
              {event.actorLabel && <span className="text-ink-secondary">({event.actorLabel})</span>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
