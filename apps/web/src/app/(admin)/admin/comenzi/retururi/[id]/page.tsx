import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReturnError, can, getAdminReturn } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Badge, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { ReturnActions } from "@/components/admin/returns/return-actions";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney, formatMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.returns;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Detaliul unui retur (Faza 14): date, produse, jurnal și acțiunile potrivite stării. Citire cu `returns.view`; acțiuni cu `returns.manage`. */
export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "returns.view" });
  const { id } = await params;
  const regional = await getSettings().getGroup("regional");
  const ret = await getAdminReturn(getDb(), id, can(subject, "customers.read_pii")).catch(
    (error: unknown) => {
      if (error instanceof ReturnError && error.code === "RETURN_NOT_FOUND") return null;
      throw error;
    },
  );
  if (!ret) notFound();
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);
  const canManage = can(subject, "returns.manage");
  const refundPending =
    ret.refund !== null && ["requested", "manual_required"].includes(ret.refund.status);
  return (
    <div className="flex max-w-5xl flex-col gap-8" data-admin-return>
      <PageHeader
        title={m.detail.title(ret.number)}
        description={`${m.detail.order}: ${ret.order.number}`}
        notes={[]}
      />
      <p className="flex flex-wrap items-center gap-3 text-body">
        <Link href="/admin/comenzi/retururi" className="underline">
          {m.detail.back}
        </Link>
        <Link href={`/admin/comenzi/${ret.order.id}`} className="underline">
          {m.detail.order} {ret.order.number}
        </Link>
        <Badge
          variant={
            ret.status === "refunded" ? "success" : ret.status === "rejected" ? "danger" : "info"
          }
        >
          {m.status[ret.status] ?? ret.status}
        </Badge>
      </p>

      <dl className="grid gap-4 sm:grid-cols-2" data-return-facts>
        <div>
          <dt className="text-label text-ink-secondary">{m.detail.customer}</dt>
          <dd>
            {ret.contactName}
            {ret.contactEmail ? ` · ${ret.contactEmail}` : ""}
            {!ret.contactEmail ? (
              <span className="block text-label text-ink-secondary">{m.detail.contactHidden}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-label text-ink-secondary">{m.detail.requested}</dt>
          <dd>{when(ret.requestedAt)}</dd>
        </div>
        <div>
          <dt className="text-label text-ink-secondary">
            {m.detail.sendMode[ret.sendMode] ?? ret.sendMode}
          </dt>
          <dd>
            {ret.returnAwb ? (
              <>
                {m.detail.awb}: <span className="font-mono">{ret.returnAwb}</span> (
                {ret.returnCarrier})
                {ret.returnTrackingUrl ? (
                  <>
                    {" "}
                    <a
                      href={ret.returnTrackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      ↗
                    </a>
                  </>
                ) : null}
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        {ret.customerNote ? (
          <div>
            <dt className="text-label text-ink-secondary">{m.detail.customerNote}</dt>
            <dd>{ret.customerNote}</dd>
          </div>
        ) : null}
        {ret.rejectReason ? (
          <div>
            <dt className="text-label text-ink-secondary">
              {getMessages().account.returns.rejectReason}
            </dt>
            <dd>{ret.rejectReason}</dd>
          </div>
        ) : null}
        {ret.refund ? (
          <div>
            <dt className="text-label text-ink-secondary">{m.actions.refundTitle}</dt>
            <dd data-return-refund-state>
              {money(ret.refund.amountMinor)} ·{" "}
              {m.detail.refundStatus[ret.refund.status] ?? ret.refund.status}{" "}
              <Link href={`/admin/comenzi/plati`} className="underline">
                {m.detail.refundOpen}
              </Link>
              {ret.refundShippingMinor > 0 ? (
                <span className="block text-label text-ink-secondary">
                  {m.actions.refundShipping}: {money(ret.refundShippingMinor)} (
                  {ret.refundShippingReason})
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {ret.stornoState ? (
          <div>
            <dt className="text-label text-ink-secondary">Storno</dt>
            <dd data-return-storno={ret.stornoState}>
              {m.detail.stornoState[ret.stornoState] ?? ret.stornoState}
              {ret.stornoNote ? (
                <span className="block text-label text-ink-secondary">{ret.stornoNote}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      <section aria-labelledby="return-items" className="flex flex-col gap-3">
        <h2 id="return-items" className="text-heading font-semibold">
          {m.detail.items}
        </h2>
        <Table stacked aria-label={m.detail.items}>
          <THead>
            <Tr>
              <Th priority="primary">{m.detail.colProduct}</Th>
              <Th priority="primary" numeric>
                {m.detail.colRequested}
              </Th>
              <Th priority="primary" numeric>
                {m.detail.colAccepted}
              </Th>
              <Th priority="secondary">{m.detail.colReason}</Th>
              <Th priority="secondary">{m.detail.colCondition}</Th>
              <Th priority="secondary" numeric>
                {m.detail.colRefund}
              </Th>
              <Th priority="secondary">{m.detail.colStock}</Th>
            </Tr>
          </THead>
          <TBody>
            {ret.items.map((i) => (
              <Tr key={i.id} data-return-item>
                <Td priority="primary">
                  {i.title}
                  {i.variantTitle ? (
                    <span className="block text-label text-ink-secondary">{i.variantTitle}</span>
                  ) : null}
                  <span className="block text-label text-ink-secondary">{i.sku}</span>
                </Td>
                <Td priority="primary" numeric>
                  {i.requestedQty} {i.unitSymbol}
                </Td>
                <Td priority="primary" numeric>
                  {i.acceptedQty === null ? "—" : `${i.acceptedQty} ${i.unitSymbol}`}
                </Td>
                <Td priority="secondary">
                  {m.reasons[i.reasonCode] ?? i.reasonCode}
                  {i.reasonText ? (
                    <span className="block text-label text-ink-secondary">{i.reasonText}</span>
                  ) : null}
                </Td>
                <Td priority="secondary">
                  {i.condition ? (m.conditions[i.condition] ?? i.condition) : "—"}
                  {i.resellable !== null ? (
                    <span className="block text-label text-ink-secondary">
                      {i.resellable ? "revandabil" : "nerevandabil"}
                    </span>
                  ) : null}
                </Td>
                <Td priority="secondary" numeric>
                  {i.refundLineMinor === null ? "—" : money(i.refundLineMinor)}
                </Td>
                <Td priority="secondary">
                  {i.restocked
                    ? "repus"
                    : i.resellable === true
                      ? i.managed
                        ? "de repus"
                        : "negestionat"
                      : "—"}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </section>

      {canManage ? (
        <ReturnActions
          returnId={ret.id}
          status={ret.status}
          sendMode={ret.sendMode}
          canRefund={can(subject, "orders.refund")}
          hasAwb={ret.returnAwb !== null}
          awbCarrier={ret.returnCarrier ?? ""}
          awbNumber={ret.returnAwb ?? ""}
          awbUrl={ret.returnTrackingUrl ?? ""}
          adminNote={ret.adminNote ?? ""}
          orderShippingText={formatMoneyInput(ret.order.shippingMinor)}
          refundPending={refundPending}
          anyRestockable={ret.items.some((i) => i.resellable === true && !i.restocked && i.managed)}
          items={ret.items.map((i) => ({
            id: i.id,
            title: i.title,
            unitSymbol: i.unitSymbol,
            requestedQty: i.requestedQty,
            acceptedQty: i.acceptedQty,
            condition: i.condition,
            resellable: i.resellable,
          }))}
        />
      ) : (
        adminNoteReadOnly(ret.adminNote)
      )}

      <section aria-labelledby="return-events" className="flex flex-col gap-3">
        <h2 id="return-events" className="text-heading font-semibold">
          {m.detail.timeline}
        </h2>
        <ol className="flex flex-col gap-2" data-return-events>
          {ret.events.map((e, index) => (
            <li key={`${e.type}-${index}`} className="flex flex-col">
              <span>
                {e.message}{" "}
                <span className="text-label text-ink-secondary">
                  ({e.visibleToCustomer ? m.detail.visible : m.detail.internal})
                </span>
              </span>
              <span className="text-label text-ink-secondary">
                {when(e.at)}
                {e.actorLabel ? ` · ${e.actorLabel}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function adminNoteReadOnly(note: string | null) {
  return note ? (
    <p className="rounded-lg bg-surface-raised p-3 text-body">
      <span className="block text-label text-ink-secondary">{m.detail.adminNote}</span>
      {note}
    </p>
  ) : null;
}
