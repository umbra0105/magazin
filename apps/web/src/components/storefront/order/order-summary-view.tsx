import { formatQuantityWithUnit, quantityFromTicks } from "@ecom/shared/quantity";
import type { OrderSummary } from "@ecom/core";
import Link from "next/link";
import { StorePill, storeButtonVariants } from "@ecom/ui";
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
  const digitalOnly = order.shipping.kind === "digital";
  // accesul digital e activ după plată (card, transfer) sau după livrarea confirmată (ramburs mixt)
  const digitalActive =
    order.digital !== null &&
    (order.digital.accessRule === "after_payment"
      ? order.paymentStatus === "paid"
      : order.fulfillmentStatus === "delivered");
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
              : order.shipping.kind === "pallet"
                ? m.paymentMethodsPallet[order.paymentMethod]
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
            {digitalOnly ? (
              m.deliveryDigital
            ) : order.shipping.kind === "pickup" ? (
              // ridicare: adresa MAGAZINULUI salvată pe comandă; adresa clientului nu apare ca destinație
              order.shipping.pickupAddressText ? (
                <span data-pickup-address>
                  {m.pickupFrom} {order.shipping.pickupAddressText}
                  {order.shipping.pickupHoursText ? (
                    <span
                      className="mt-1 block text-sm font-normal text-ink-secondary"
                      data-pickup-hours
                    >
                      {m.pickupHours} {order.shipping.pickupHoursText}
                    </span>
                  ) : null}
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

      {order.digital ? (
        <section
          aria-label={m.digitalAccess.title}
          className="flex flex-col gap-2 rounded-card bg-card p-5"
          data-digital-access={digitalActive ? "active" : "pending"}
        >
          <h2 className="text-lg font-semibold">{m.digitalAccess.title}</h2>
          <p>
            {digitalActive
              ? m.digitalAccess.activeNow
              : order.digital.accessRule === "after_delivery"
                ? m.digitalAccess.afterDelivery
                : m.digitalAccess.afterPayment}{" "}
            {m.digitalAccess.where}
          </p>
          {order.digital.consentText ? (
            <p className="text-sm text-ink-secondary" data-digital-consent-saved>
              <span className="font-medium">{m.digitalAccess.consentHeading}:</span>{" "}
              {order.digital.consentText}
            </p>
          ) : null}
          <p>
            <Link
              href="/cont/produsele-mele"
              className={storeButtonVariants({ variant: "secondary" })}
              data-digital-library-link
            >
              {m.digitalAccess.open}
            </Link>
          </p>
        </section>
      ) : null}

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
          {digitalOnly ? null : (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-secondary">{getMessages().storefront.checkout.shipping}</dt>
              <dd className="tabular-nums">
                {order.totals.shippingMinor === 0
                  ? getMessages().storefront.checkout.free
                  : money(order.totals.shippingMinor)}
              </dd>
            </div>
          )}
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
