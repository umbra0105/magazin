import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getAdminOrderDetail, INSTALLATION_STATUSES, listOrderShipments } from "@ecom/core";
import { getDb } from "@ecom/db";
import { templateDefinition } from "@ecom/jobs";
import { formatQuantityWithUnit, quantityFromTicks } from "@ecom/shared";
import { Badge, RowHeader, Section, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import {
  InstallationStatusForm,
  NoteForm,
  ResendEmailButton,
} from "@/components/admin/orders/order-panels";
import { CrumbLabel } from "@/components/admin/crumb-labels";
import { ShipmentPanel, type ShipmentDto } from "@/components/admin/shipping/shipment-panel";
import { OrderActions } from "@/components/admin/orders/order-actions";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import {
  EMAIL_STATUS_TONE,
  FULFILLMENT_STATUS_TONE,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_TONE,
} from "@/lib/order-tones";
import { getCarrierRuntime } from "@/lib/shipping";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;
const REFUND_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  requested: "warning",
  confirmed: "success",
  failed: "danger",
  manual_required: "danger",
};

export const metadata: Metadata = { title: t.title };
export const dynamic = "force-dynamic";

/**
 * Detaliul unei comenzi din admin (Faza 11): liniile (instantaneu imuabil), plata cu rambursările, livrarea și adresele, clientul,
 * notele interne, emailurile și cronologia. Cere `orders.read`; fiecare secțiune sensibilă cere dreptul ei (date personale,
 * `payments.read`, `email.read`) și lipsește din răspuns dacă nu-l ai. Acțiunile cer fiecare permisiunea ei, verificată pe server.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "orders.read" });
  const { id } = await params;
  const db = getDb();
  const viewer = {
    pii: can(subject, "customers.read_pii") || can(subject, "orders.fulfill"),
    payments: can(subject, "payments.read"),
    emails: can(subject, "email.read"),
  };
  const detail = await getAdminOrderDetail(db, id, viewer);
  if (!detail) notFound();
  const regional = await getSettings().getGroup("regional");
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);

  // limita rolului Suport: ce mai poate rambursa pe această comandă (serverul o aplică oricum, sub blocare)
  const unlimited = can(subject, "payments.refund");
  let limit: { limitMinor: number; remainingMinor: number } | null = null;
  if (can(subject, "orders.refund") && !unlimited && detail.refundable) {
    const limitMinor = (await getSettings().getGroupUncached("payment")).supportRefundLimit;
    const used = await db.refund.aggregate({
      where: { orderId: id, limitedActor: true, status: { not: "failed" } },
      _sum: { amountMinor: true },
    });
    limit = { limitMinor, remainingMinor: Math.max(0, limitMinor - (used._sum.amountMinor ?? 0)) };
  }

  // expedierea (Faza 12): AWB-urile comenzii, curierul activ și transportatorii din setări
  const shipmentRows = await listOrderShipments(db, id);
  const activeCarrier = can(subject, "orders.fulfill")
    ? await getCarrierRuntime().activeCarrier()
    : null;
  const manualCarriers = (await getSettings().getGroup("shipping")).manualCarriers;
  const shipments: ShipmentDto[] = shipmentRows.map((s) => ({
    id: s.id,
    kind: s.kind,
    mode: s.mode,
    provider: s.provider,
    carrier: s.carrier,
    awb: s.awb,
    trackingUrl: s.trackingUrl,
    status: s.status,
    codText: s.codAmountMinor > 0 ? money(s.codAmountMinor) : null,
    createdText: when(s.createdAt),
    deliveredText: s.deliveredAt ? when(s.deliveredAt) : null,
    syncedText: s.lastSyncedAt ? when(s.lastSyncedAt) : null,
    events: s.events.map((event) => ({ label: event.label, whenText: when(event.occurredAt) })),
  }));
  const paymentLabel =
    (detail.shipping.kind === "pallet" ? t.methodsPallet[detail.paymentMethod] : undefined) ??
    t.methods[detail.paymentMethod] ??
    detail.paymentMethod;
  const moneyHeld = ["paid", "partially_refunded", "authorized"].includes(detail.paymentStatus);
  const shippingAddress = detail.addresses?.find((a) => a.kind === "shipping") ?? null;
  const billingAddress = detail.addresses?.find((a) => a.kind === "billing") ?? null;
  const pickup = detail.shipping.kind === "pickup";
  const refundedTotal = (detail.payments ?? []).reduce((sum, p) => sum + p.refundCommittedMinor, 0);
  const owed = detail.refundable?.remainingMinor ?? 0;
  const attention = (detail.payments ?? []).find((p) => p.attentionReason)?.attentionReason ?? null;

  const addressFields = (a: NonNullable<typeof shippingAddress>) => ({
    fullName: a.fullName,
    phone: a.phone,
    street: a.street,
    postalCode: a.postalCode,
  });

  return (
    <div className="flex max-w-5xl flex-col gap-6" data-order-detail>
      <CrumbLabel label={detail.number} />
      <div className="flex flex-col gap-3">
        <Link
          href="/admin/comenzi"
          className="text-body text-link underline-offset-2 hover:underline"
        >
          {t.detail.back}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title">{t.detail.title(detail.number)}</h1>
          <Badge variant={ORDER_STATUS_TONE[detail.status] ?? "neutral"} dot>
            {t.statuses[detail.status] ?? detail.status}
          </Badge>
          <Badge variant={PAYMENT_STATUS_TONE[detail.paymentStatus] ?? "neutral"} dot>
            {t.paymentStatuses[detail.paymentStatus] ?? detail.paymentStatus}
          </Badge>
          <Badge variant={FULFILLMENT_STATUS_TONE[detail.fulfillmentStatus] ?? "neutral"} dot>
            {t.fulfillmentStatuses[detail.fulfillmentStatus] ?? detail.fulfillmentStatus}
          </Badge>
          {detail.supplier && <Badge variant="warning">{t.badges.supplier}</Badge>}
          {detail.installation.status && (
            <Badge variant="info">
              {t.badges.installation}:{" "}
              {t.installationStatuses[detail.installation.status] ?? detail.installation.status}
            </Badge>
          )}
        </div>
        <p className="text-body text-ink-secondary">
          {t.detail.placed(when(detail.placedAt))} · {t.detail.channel}: {detail.channelName} ·{" "}
          {paymentLabel}
        </p>
        {detail.reservationExpiresAt && detail.status === "pending" && (
          <p className="text-body text-ink-secondary">
            {t.detail.reserved(when(detail.reservationExpiresAt))}
          </p>
        )}
        {detail.paymentRetryDeadlineAt &&
          detail.status === "pending" &&
          detail.paymentMethod === "card" && (
            <p className="text-body text-ink-secondary">
              {t.detail.retryUntil(when(detail.paymentRetryDeadlineAt))}
            </p>
          )}
      </div>

      {detail.status === "cancelled" && detail.needsRefund && (
        <section
          aria-labelledby="owed-title"
          data-needs-refund
          className="rounded-lg bg-tone-warning-bg p-4 text-tone-warning-fg"
        >
          <h2 id="owed-title" className="text-heading">
            {t.detail.needsRefund(money(owed))}
          </h2>
          <p className="mt-1 text-body">{t.detail.needsRefundHelp}</p>
        </section>
      )}
      {attention && detail.status !== "cancelled" && (
        <section
          aria-labelledby="attention-title"
          className="rounded-lg bg-tone-warning-bg p-4 text-tone-warning-fg"
        >
          <h2 id="attention-title" className="text-heading">
            {t.detail.attentionTitle}: {t.detail.payment.attention[attention] ?? attention}
          </h2>
        </section>
      )}

      <OrderActions
        orderId={detail.id}
        status={detail.status}
        paymentStatus={detail.paymentStatus}
        paymentMethod={detail.paymentMethod}
        fulfillmentStatus={detail.fulfillmentStatus}
        totalMinor={detail.totals.totalMinor}
        currency={regional.currency}
        locale={regional.locale}
        moneyHeld={moneyHeld}
        caps={{
          process: can(subject, "orders.write"),
          cancel: can(subject, "orders.cancel"),
          refund: can(subject, "orders.refund"),
          markPaid: can(subject, "orders.mark_paid"),
          edit: can(subject, "orders.write"),
          supplier: can(subject, "orders.write"),
        }}
        refund={
          detail.refundable && detail.refundable.remainingMinor > 0
            ? { remainingMinor: detail.refundable.remainingMinor, limit }
            : null
        }
        supplier={
          detail.supplier ? { name: detail.supplier.name, note: detail.supplier.note } : null
        }
        duplicateHref={
          can(subject, "orders.offers")
            ? `/admin/comenzi/oferte/nou?dinComanda=${encodeURIComponent(detail.id)}`
            : null
        }
        edit={
          detail.contact && shippingAddress
            ? {
                email: detail.contact.email,
                phone: detail.contact.phone,
                shipping: addressFields(shippingAddress),
                billing: billingAddress ? addressFields(billingAddress) : null,
              }
            : null
        }
      />

      <Section id="lines" title={t.detail.sections.lines}>
        <Table stacked aria-label={t.detail.sections.lines}>
          <THead>
            <Tr>
              <Th priority="primary">{t.detail.lines.product}</Th>
              <Th priority="primary" numeric>
                {t.detail.lines.quantity}
              </Th>
              <Th priority="secondary" numeric>
                {t.detail.lines.unitPrice}
              </Th>
              <Th priority="tertiary" numeric>
                {t.detail.lines.vat}
              </Th>
              <Th priority="primary" numeric>
                {t.detail.lines.total}
              </Th>
            </Tr>
          </THead>
          <TBody>
            {detail.lines.map((line) => (
              <Tr key={line.id}>
                <RowHeader stack="title" className="font-medium">
                  {line.title}
                  {line.variantTitle && (
                    <span className="block text-label font-normal text-ink-secondary">
                      {line.variantTitle}
                    </span>
                  )}
                  <span className="block text-label font-normal text-ink-secondary">
                    {t.detail.lines.sku}: {line.sku}
                    {line.stockState === "on_order"
                      ? ` · ${t.detail.lines.onOrder(line.leadTimeDays)}`
                      : ""}
                  </span>
                </RowHeader>
                <Td priority="primary" numeric className="whitespace-nowrap tabular-nums">
                  {formatQuantityWithUnit(
                    quantityFromTicks(BigInt(line.quantityTicks)),
                    line.unitSymbol,
                  )}
                </Td>
                <Td priority="secondary" numeric className="whitespace-nowrap tabular-nums">
                  {money(line.unitPriceMinor)}
                </Td>
                <Td priority="tertiary" numeric className="whitespace-nowrap tabular-nums">
                  {money(line.taxMinor)}
                </Td>
                <Td priority="primary" numeric className="whitespace-nowrap tabular-nums">
                  {money(line.lineTotalMinor)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-body tabular-nums">
          <dt className="text-ink-secondary">{t.detail.lines.subtotal}</dt>
          <dd className="text-right">{money(detail.totals.subtotalMinor)}</dd>
          {detail.totals.discountMinor > 0 && (
            <>
              <dt className="text-ink-secondary">{t.detail.lines.discount}</dt>
              <dd className="text-right">−{money(detail.totals.discountMinor)}</dd>
            </>
          )}
          <dt className="text-ink-secondary">{t.detail.lines.shipping}</dt>
          <dd className="text-right">{money(detail.totals.shippingMinor)}</dd>
          {detail.totals.codFeeMinor > 0 && (
            <>
              <dt className="text-ink-secondary">{t.detail.lines.codFee}</dt>
              <dd className="text-right">{money(detail.totals.codFeeMinor)}</dd>
            </>
          )}
          <dt className="text-ink-secondary">{t.detail.lines.tax}</dt>
          <dd className="text-right">{money(detail.totals.taxMinor)}</dd>
          <dt className="font-semibold">{t.detail.lines.grandTotal}</dt>
          <dd className="text-right font-semibold" data-order-total>
            {money(detail.totals.totalMinor)}
          </dd>
        </dl>
        <p className="text-label text-ink-secondary">{t.detail.lines.editNote}</p>
      </Section>

      {detail.payments && (
        <Section id="payment" title={t.detail.sections.payment}>
          <dl className="grid gap-x-6 gap-y-3 md:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-label text-ink-secondary">{t.detail.payment.method}</dt>
              <dd>{paymentLabel}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-label text-ink-secondary">{t.detail.payment.refunded}</dt>
              <dd className="tabular-nums">{money(refundedTotal)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-label text-ink-secondary">{t.detail.payment.remaining}</dt>
              <dd className="tabular-nums">{money(owed)}</dd>
            </div>
          </dl>
          {detail.payments.length === 0 ? (
            <p className="text-body text-ink-secondary">{t.detail.payment.noPayments}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {detail.payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {t.detail.payment.attempt(payment.attemptNo)}
                    </span>
                    <Badge
                      variant={
                        payment.status === "paid"
                          ? "success"
                          : payment.status === "failed"
                            ? "danger"
                            : "neutral"
                      }
                      dot
                    >
                      {t.detail.payment.paymentStatus[payment.status] ?? payment.status}
                    </Badge>
                    {payment.attentionReason && (
                      <Badge variant="warning">
                        {t.detail.payment.attention[payment.attentionReason] ??
                          payment.attentionReason}
                      </Badge>
                    )}
                    <span className="tabular-nums">{money(payment.amountMinor)}</span>
                    <span className="text-ink-secondary">
                      {t.detail.payment.providers[payment.provider] ?? payment.provider}
                      {payment.cardLast4 ? ` •••• ${payment.cardLast4}` : ""}
                    </span>
                    {payment.method === "card" && (
                      <Link
                        href={`/admin/comenzi/plati/${payment.id}`}
                        className="ml-auto text-link underline-offset-2 hover:underline"
                      >
                        {t.detail.payment.openPayment}
                      </Link>
                    )}
                  </div>
                  {payment.refunds.length > 0 && (
                    <ul className="flex flex-col gap-1 text-body">
                      {payment.refunds.map((refund) => (
                        <li key={refund.id} className="flex flex-wrap items-center gap-2">
                          <Badge variant={REFUND_TONE[refund.status] ?? "neutral"} dot>
                            {t.detail.payment.refundStatus[refund.status] ?? refund.status}
                          </Badge>
                          <span className="tabular-nums">{money(refund.amountMinor)}</span>
                          <span className="text-ink-secondary">
                            {refund.reason}
                            {refund.limitedActor ? ` · ${t.detail.payment.byLimited}` : ""}
                          </span>
                          <span className="text-label text-ink-secondary">
                            {when(refund.createdAt)}
                          </span>
                          {refund.status === "manual_required" && (
                            <span className="text-label text-tone-problem-fg">
                              {t.detail.payment.manualHelp}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section id="shipping" title={getMessages().admin.shipping.panel.title}>
        <ShipmentPanel
          orderId={detail.id}
          shippingKind={detail.shipping.kind}
          canShip={
            ["confirmed", "processing"].includes(detail.status) &&
            detail.fulfillmentStatus === "unfulfilled"
          }
          canFulfill={can(subject, "orders.fulfill")}
          hasActiveOutbound={shipments.some(
            (s) => s.kind === "outbound" && s.status !== "cancelled",
          )}
          shipments={shipments}
          carrier={
            activeCarrier
              ? {
                  label: activeCarrier.label,
                  demo: activeCarrier.code === "demo",
                  untested: activeCarrier.code !== "demo",
                }
              : null
          }
          manualCarriers={manualCarriers}
        />
      </Section>

      <Section id="delivery" title={t.detail.sections.delivery}>
        {pickup ? (
          <>
            <p data-pickup-address>
              {detail.shipping.pickupAddressText
                ? `${t.detail.delivery.pickup} ${detail.shipping.pickupAddressText}`
                : t.detail.delivery.noPickupAddress}
            </p>
            {detail.shipping.pickupHoursText ? (
              <p data-pickup-hours>
                {t.detail.delivery.pickupHours} {detail.shipping.pickupHoursText}
              </p>
            ) : null}
          </>
        ) : (
          <p>
            {detail.shipping.carrier}
            {detail.shipping.service ? ` — ${detail.shipping.service}` : ""}
            {detail.shipping.estimatedDays !== null
              ? ` · ${t.detail.delivery.estimate(detail.shipping.estimatedDays)}`
              : ""}
            {detail.shipping.freeShipping ? ` · ${t.detail.delivery.free}` : ""}
          </p>
        )}
        {detail.addresses === null ? (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {t.detail.delivery.hiddenNote}
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {[shippingAddress, billingAddress]
              .flatMap((address) => (address ? [address] : []))
              .map((address) => (
                <div
                  key={address.kind}
                  className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-3"
                  data-address={address.kind}
                >
                  <h3 className="text-heading">
                    {address.kind === "billing"
                      ? t.detail.delivery.billingAddress
                      : pickup
                        ? t.detail.delivery.shippingAddress
                        : t.detail.delivery.shippingAddressCourier}
                  </h3>
                  <p>{address.fullName}</p>
                  {address.company && (
                    <p>
                      {t.detail.delivery.company}: {address.company}
                      {address.vatId ? ` · ${t.detail.delivery.vatId}: ${address.vatId}` : ""}
                      {address.vatIdVerification
                        ? ` (${address.vatIdVerification === "verified" ? t.detail.delivery.vatVerified : t.detail.delivery.vatUnverified})`
                        : ""}
                    </p>
                  )}
                  <p>
                    {address.street}, {address.postalCode} {address.localityName},{" "}
                    {address.countyName}
                  </p>
                  <p className="text-ink-secondary">
                    {t.detail.delivery.phone}: {address.phone}
                  </p>
                </div>
              ))}
          </div>
        )}
        {pickup && detail.addresses !== null && (
          <p className="text-label text-ink-secondary">{t.detail.delivery.pickupNote}</p>
        )}
      </Section>

      <Section id="customer" title={t.detail.sections.customer}>
        {detail.contact === null ? (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {t.detail.customer.hidden}
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-label text-ink-secondary">{t.detail.customer.email}</dt>
              <dd className="break-all">{detail.contact.email}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-label text-ink-secondary">{t.detail.customer.phone}</dt>
              <dd>{detail.contact.phone}</dd>
            </div>
            <div className="flex flex-col md:col-span-2">
              <dt className="text-label text-ink-secondary">{t.detail.customer.note}</dt>
              <dd className="whitespace-pre-line">
                {detail.customerNote ?? t.detail.customer.none}
              </dd>
            </div>
          </dl>
        )}
        <p className="text-label text-ink-secondary">
          {t.detail.customer.consent(detail.consent.version, when(detail.consent.acceptedAt))}
        </p>
      </Section>

      {detail.installation.status && (
        <Section id="installation" title={t.detail.sections.installation}>
          <p>
            {t.detail.installation.status}:{" "}
            <strong>
              {t.installationStatuses[detail.installation.status] ?? detail.installation.status}
            </strong>
          </p>
          {detail.installation.note && (
            <p className="whitespace-pre-line text-ink-secondary">
              {t.detail.installation.note}: {detail.installation.note}
            </p>
          )}
          {can(subject, "orders.write") && (
            <InstallationStatusForm
              orderId={detail.id}
              current={detail.installation.status}
              statuses={INSTALLATION_STATUSES.map((value) => ({
                value,
                label: t.installationStatuses[value] ?? value,
              }))}
            />
          )}
        </Section>
      )}

      {detail.supplier && (
        <Section id="supplier" title={t.detail.sections.supplier}>
          <p>{t.detail.supplier.since(detail.supplier.markedBy, when(detail.supplier.markedAt))}</p>
          {detail.supplier.name && (
            <p>
              {t.detail.supplier.name}: {detail.supplier.name}
            </p>
          )}
          {detail.supplier.note && (
            <p className="whitespace-pre-line text-ink-secondary">
              {t.detail.supplier.note}: {detail.supplier.note}
            </p>
          )}
        </Section>
      )}

      <Section id="notes" title={t.detail.sections.notes}>
        {can(subject, "orders.write") && <NoteForm orderId={detail.id} />}
        {detail.notes.length === 0 ? (
          <p className="text-body text-ink-secondary">{t.detail.notes.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.notes.map((note) => (
              <li key={note.id} className="rounded-lg bg-surface-subtle p-3">
                <p className="whitespace-pre-line">{note.body}</p>
                <p className="mt-1 text-label text-ink-secondary">
                  {t.detail.notes.by(note.authorLabel, when(note.createdAt))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.emails && (
        <Section id="emails" title={t.detail.sections.emails}>
          {detail.emails.length === 0 ? (
            <p className="text-body text-ink-secondary">{t.detail.emails.empty}</p>
          ) : (
            <Table stacked aria-label={t.detail.sections.emails}>
              <THead>
                <Tr>
                  <Th priority="primary">{t.detail.emails.template}</Th>
                  <Th priority="secondary">{t.detail.emails.recipient}</Th>
                  <Th priority="primary">{t.detail.emails.status}</Th>
                  <Th priority="tertiary">{t.detail.emails.when}</Th>
                  <Th priority="primary">
                    <span className="sr-only">{t.columns.actions}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {detail.emails.map((email) => {
                  const label = templateDefinition(email.template)?.label ?? email.template;
                  return (
                    <Tr key={email.id}>
                      <RowHeader stack="title" className="font-medium">
                        {label}
                        {email.audience === "internal" && (
                          <span className="ml-2 text-label font-normal text-ink-secondary">
                            {t.detail.emails.internal}
                          </span>
                        )}
                        {email.lastError && (
                          <span className="block text-label font-normal text-tone-problem-fg">
                            {email.lastError}
                          </span>
                        )}
                      </RowHeader>
                      <Td priority="secondary" className="break-all">
                        {email.recipient}
                      </Td>
                      <Td priority="primary">
                        <Badge variant={EMAIL_STATUS_TONE[email.status] ?? "neutral"} dot>
                          {t.detail.emails.statuses[email.status] ?? email.status}
                        </Badge>
                      </Td>
                      <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                        {when(email.sentAt ?? email.createdAt)}
                      </Td>
                      <Td priority="primary" stack="actions">
                        {can(subject, "orders.write") &&
                          !["queued", "sending"].includes(email.status) && (
                            <ResendEmailButton
                              orderId={detail.id}
                              dispatchId={email.id}
                              label={label}
                            />
                          )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Section>
      )}

      <Section id="timeline" title={t.detail.sections.timeline}>
        {detail.events.length === 0 ? (
          <p className="text-body text-ink-secondary">{t.detail.timeline.empty}</p>
        ) : (
          <ol className="flex flex-col gap-2" data-timeline>
            {detail.events
              .slice()
              .reverse()
              .map((event) => (
                <li
                  key={event.id}
                  className="flex flex-col gap-0.5 border-l-2 border-line-subtle pl-3"
                >
                  <span>{event.message}</span>
                  <span className="text-label text-ink-secondary">
                    {when(event.createdAt)} · {event.actorLabel ?? t.detail.timeline.system}
                  </span>
                </li>
              ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
