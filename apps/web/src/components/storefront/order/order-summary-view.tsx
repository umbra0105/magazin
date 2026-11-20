import { formatQuantityWithUnit, quantityFromTicks } from "@ecom/shared/quantity";
import type { OrderSummary } from "@ecom/core";
import { StorePill } from "@ecom/ui";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().storefront.order;

/**
 * Rezumatul unei comenzi pentru client (pagina de confirmare și urmărirea): stările, liniile, sumele și livrarea. Fără strada,
 * telefonul sau emailul (nu fac parte din `OrderSummary`). Componentă de server: banii și datele se formatează aici.
 */
export function OrderSummaryView({
  order,
  format,
  timeZone,
}: {
  order: OrderSummary;
  format: { currency: string; locale: string };
  timeZone: string;
}) {
  const money = (minor: number) => formatMoney(minor, format.currency, format.locale);
  const statusLabel = m.statuses[order.status] ?? order.status;
  const payLabel = m.paymentStatuses[order.paymentStatus] ?? order.paymentStatus;
  const fulfilLabel = m.fulfillmentStatuses[order.fulfillmentStatus] ?? order.fulfillmentStatus;
  return (
    <div className="flex flex-col gap-8" data-order-summary-view>
      {order.paymentNotice === "stock_lost" ? (
        <p
          role="note"
          className="rounded-card bg-tone-warning-bg p-4 text-tone-warning-fg"
          data-payment-notice
        >
          {m.stockLostNotice}
        </p>
      ) : null}
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-ink-secondary">{m.status}</dt>
          <dd className="mt-1 flex flex-wrap gap-2">
            <StorePill tone={order.status === "cancelled" ? "problem" : "info"}>
              {statusLabel}
            </StorePill>
            <StorePill tone={order.paymentStatus === "paid" ? "success" : "warning"}>
              {payLabel}
            </StorePill>
            <StorePill tone="info">{fulfilLabel}</StorePill>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-ink-secondary">{m.payment}</dt>
          <dd className="mt-1 font-medium">
            {(order.shipping.kind === "pickup"
              ? m.paymentMethodsPickup[order.paymentMethod]
              : undefined) ??
              m.paymentMethods[order.paymentMethod] ??
              order.paymentMethod}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-ink-secondary">
            {order.shipping.kind === "pickup" ? m.pickupLabel : m.delivery}
          </dt>
          <dd className="mt-1 font-medium">
            {order.shipping.kind === "pickup" ? (
              // ridicare: adresa MAGAZINULUI salvată pe comandă; adresa clientului nu apare ca destinație
              order.shipping.pickupAddressText ? (
                <span data-pickup-address>
                  {m.pickupFrom} {order.shipping.pickupAddressText}
                </span>
              ) : (
                m.pickupNoAddress
              )
            ) : (
              `${order.shipping.carrier}${order.shipping.service ? ` — ${order.shipping.service}` : ""}`
            )}
            {order.destination ? (
              <span className="block text-sm font-normal text-ink-secondary">
                {m.deliveryTo} {order.destination.localityName}, {order.destination.countyName}
              </span>
            ) : null}
            {order.shipping.estimatedDays !== null && order.shipping.kind !== "pickup" ? (
              <span className="block text-sm font-normal text-ink-secondary">
                {m.estimate(order.shipping.estimatedDays)}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {order.longestLeadTimeDays !== null ? (
        <p className="text-sm font-medium">{m.leadTime(order.longestLeadTimeDays)}</p>
      ) : null}
      {order.installationRequested ? <p className="text-sm">{m.installRequested}</p> : null}

      <section aria-label={m.lines}>
        <h2 className="mb-2 text-lg font-semibold">{m.lines}</h2>
        <ul className="flex flex-col divide-y divide-line-subtle">
          {order.lines.map((line, index) => (
            <li key={index} className="flex items-start justify-between gap-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">{line.title}</span>
                {line.variantTitle ? (
                  <span className="block text-sm text-ink-secondary">{line.variantTitle}</span>
                ) : null}
                <span className="block text-sm text-ink-secondary">
                  {formatQuantityWithUnit(
                    quantityFromTicks(BigInt(line.quantityTicks)),
                    line.unitSymbol,
                  )}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{money(line.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 flex flex-col gap-1.5 border-t border-line-subtle pt-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{getMessages().storefront.checkout.products}</dt>
            <dd className="tabular-nums">{money(order.totals.subtotalMinor)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{getMessages().storefront.checkout.shipping}</dt>
            <dd className="tabular-nums">
              {order.totals.shippingMinor === 0
                ? getMessages().storefront.checkout.free
                : money(order.totals.shippingMinor)}
            </dd>
          </div>
          {order.totals.codFeeMinor > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-secondary">{getMessages().storefront.checkout.codFee}</dt>
              <dd className="tabular-nums">{money(order.totals.codFeeMinor)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4 text-base font-semibold">
            <dt>{m.total}</dt>
            <dd className="tabular-nums" data-order-total>
              {money(order.totals.totalMinor)}
            </dd>
          </div>
          <div className="text-right text-ink-secondary tabular-nums">
            {getMessages().storefront.checkout.vatIncluded(money(order.totals.taxMinor))}
          </div>
        </dl>
      </section>
      <p className="text-sm text-ink-secondary">
        {m.placedOn(formatDateTime(order.placedAt, format.locale, timeZone))}
      </p>
    </div>
  );
}
