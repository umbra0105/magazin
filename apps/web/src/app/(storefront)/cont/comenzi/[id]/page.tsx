import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatQuantityWithUnit, quantityFromTicks } from "@ecom/shared";
import { AccountError, getAccountOrder, type AccountAddressView } from "@ecom/core";
import { StoreCard, StorePill, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { ReorderButton } from "@/components/storefront/account/reorder-button";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.orders.title };
export const dynamic = "force-dynamic";

function AddressBlock({ title, address }: { title: string; address: AccountAddressView | null }) {
  if (!address) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="font-semibold">{title}</h3>
      <p className="text-ink-secondary">
        {address.company
          ? `${address.company}${address.vatId ? ` (${address.vatId})` : ""}`
          : address.fullName}
        <br />
        {address.street}
        <br />
        {address.postalCode} {address.localityName}, {address.countyName}
        <br />
        {address.phone}
      </p>
    </section>
  );
}

/**
 * Detaliul unei comenzi în cont: linii, adrese, plată, cronologie construită DOAR din evenimente vizibile clientului, AWB cu link de
 * urmărire, facturi cu descărcare (rută cu verificare de proprietate), retururi, «solicită retur» (doar în fereastră) și «comandă din
 * nou». O comandă care nu e a clientului dă 404, ca una inexistentă.
 */
export default async function AccountOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCustomer(`/cont/comenzi/${id}`);
  const [format, order] = await Promise.all([
    getAccountFormat(),
    getAccountOrder(getDb(), user, id, new Date()).catch((error: unknown) => {
      if (error instanceof AccountError && error.code === "ACCOUNT_ORDER_NOT_FOUND") return null;
      throw error;
    }),
  ]);
  if (!order) notFound();
  const w = order.returnWindow;
  const hasEnded = !w.open && w.deliveredAt !== null;
  return (
    <div className="flex flex-col gap-8" data-account-order>
      <header className="flex flex-col gap-2">
        <Link href="/cont/comenzi" className="text-sm font-medium underline underline-offset-4">
          {m.orders.backToList}
        </Link>
        <h1 className="heading-display text-3xl sm:text-4xl">
          {m.orders.number} {order.number}
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-ink-secondary">
          {m.orders.placed} {format.dateTime(order.placedAt)}
          <StorePill tone={order.status === "cancelled" ? "problem" : "info"}>
            {m.orderStatus[order.status as keyof typeof m.orderStatus] ?? order.status}
          </StorePill>
          <StorePill tone={order.paymentStatus === "paid" ? "success" : "warning"}>
            {m.paymentStatus[order.paymentStatus as keyof typeof m.paymentStatus] ??
              order.paymentStatus}
          </StorePill>
          <StorePill tone="neutral">
            {m.fulfillmentStatus[order.fulfillmentStatus as keyof typeof m.fulfillmentStatus] ??
              order.fulfillmentStatus}
          </StorePill>
        </p>
      </header>

      <section aria-labelledby="order-lines" className="flex flex-col gap-3">
        <h2 id="order-lines" className="text-xl font-semibold">
          {m.detail.products}
        </h2>
        <StoreCard className="p-4">
          <ul className="flex flex-col divide-y divide-line-input">
            {order.lines.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-3"
              >
                <span>
                  <span className="font-medium">{line.title}</span>
                  {line.variantTitle ? (
                    <span className="block text-sm text-ink-secondary">{line.variantTitle}</span>
                  ) : null}
                  <span className="block text-sm text-ink-secondary">
                    {formatQuantityWithUnit(quantityFromTicks(line.quantity), line.unitSymbol)} ×{" "}
                    {format.money(line.unitPriceMinor)}
                  </span>
                </span>
                <span className="font-medium">{format.money(line.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid gap-1 border-t border-line-input pt-4 text-sm">
            <div className="flex justify-between">
              <dt>{m.detail.subtotal}</dt>
              <dd>{format.money(order.subtotalMinor)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>{m.detail.shipping}</dt>
              <dd>
                {order.shippingMinor === 0 ? m.detail.free : format.money(order.shippingMinor)}
              </dd>
            </div>
            {order.codFeeMinor > 0 ? (
              <div className="flex justify-between">
                <dt>{m.detail.codFee}</dt>
                <dd>{format.money(order.codFeeMinor)}</dd>
              </div>
            ) : null}
            {order.discountMinor > 0 ? (
              <div className="flex justify-between">
                <dt>{m.detail.discount}</dt>
                <dd>−{format.money(order.discountMinor)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between text-ink-secondary">
              <dt>{m.detail.vat}</dt>
              <dd>{format.money(order.taxMinor)}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>{m.detail.total}</dt>
              <dd>{format.money(order.totalMinor)}</dd>
            </div>
          </dl>
        </StoreCard>
        <p className="text-sm text-ink-secondary">
          {m.detail.payment}:{" "}
          {m.paymentMethod[order.paymentMethod as keyof typeof m.paymentMethod] ??
            order.paymentMethod}
        </p>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        <AddressBlock title={m.detail.shippingAddress} address={order.shippingAddress} />
        <AddressBlock title={m.detail.billingAddress} address={order.billingAddress} />
      </div>

      {order.shipments.length > 0 ? (
        <section aria-labelledby="order-shipments" className="flex flex-col gap-2">
          <h2 id="order-shipments" className="text-xl font-semibold">
            {m.detail.shipments}
          </h2>
          <ul className="flex flex-col gap-2">
            {order.shipments.map((s) => (
              <li key={s.awb} className="flex flex-wrap items-center gap-3">
                <span>
                  {s.carrier} · {m.detail.awb} <span className="font-mono">{s.awb}</span>
                </span>
                {s.trackingUrl ? (
                  <a
                    href={s.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {m.detail.track}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="order-timeline" className="flex flex-col gap-3">
        <h2 id="order-timeline" className="text-xl font-semibold">
          {m.detail.timeline}
        </h2>
        <ol className="flex flex-col gap-3 border-l-2 border-line-input pl-4" data-timeline>
          {order.timeline.map((e, i) => (
            <li key={`${e.type}-${i}`} className="flex flex-col">
              <span className="font-medium">{m.timelineEvent[e.type] ?? e.type}</span>
              <span className="text-sm text-ink-secondary">
                {format.dateTime(e.at)}
                {e.awb ? ` · ${m.detail.awb} ${e.awb}${e.carrier ? ` (${e.carrier})` : ""}` : ""}
                {e.amountMinor !== null && e.type === "payment.refunded"
                  ? ` · ${format.money(e.amountMinor)}`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="order-invoices" className="flex flex-col gap-2">
        <h2 id="order-invoices" className="text-xl font-semibold">
          {m.detail.invoices}
        </h2>
        {order.invoices.length === 0 ? (
          <p className="text-ink-secondary">{m.detail.noInvoices}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {order.invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3">
                <span>
                  {m.detail.invoiceKind[inv.kind] ?? inv.kind} {inv.series ?? ""} {inv.number ?? ""}{" "}
                  · {format.money(inv.totalMinor)}
                </span>
                {inv.simulated ? <StorePill tone="warning">{m.detail.simulated}</StorePill> : null}
                <a
                  href={`/api/account/invoices/${inv.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {m.detail.downloadInvoice}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="order-returns" className="flex flex-col gap-3">
        <h2 id="order-returns" className="text-xl font-semibold">
          {m.detail.returnsOfOrder}
        </h2>
        {order.returns.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {order.returns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/cont/retururi/${r.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {m.returns.number(r.number)}
                </Link>
                <StorePill tone="info">{m.returnStatus[r.status] ?? r.status}</StorePill>
              </li>
            ))}
          </ul>
        ) : null}
        {order.canRequestReturn && w.endsAt ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-secondary">
              {m.detail.returnWindowOpen(format.date(w.endsAt))}
            </p>
            <div>
              <Link
                href={`/cont/retururi/nou?comanda=${order.id}`}
                className={storeButtonVariants({ variant: "primary" })}
              >
                {m.detail.requestReturn}
              </Link>
            </div>
          </div>
        ) : !w.deliveredAt ? (
          <p className="text-sm text-ink-secondary">{m.detail.returnNoDelivery}</p>
        ) : hasEnded ? (
          <p className="text-sm text-ink-secondary">{m.detail.returnWindowClosed(w.windowDays)}</p>
        ) : (
          <p className="text-sm text-ink-secondary">{m.detail.returnNothingLeft}</p>
        )}
      </section>

      <ReorderButton orderId={order.id} />
    </div>
  );
}
