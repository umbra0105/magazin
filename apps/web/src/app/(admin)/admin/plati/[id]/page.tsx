import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, paymentDetail } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Badge, Section } from "@ecom/ui";
import { ManualRefundForm, RefundForm } from "@/components/admin/payments/refund-panel";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.payments;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning",
  paid: "success",
  failed: "danger",
  cancelled: "neutral",
  refunded: "info",
};
const REFUND_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  requested: "warning",
  confirmed: "success",
  failed: "danger",
  manual_required: "danger",
};

/**
 * Detaliul unei plăți: sumele, încercările, cronologia comenzii, rambursările și formularele de rambursare. Cere
 * `payments.read`; rambursarea și «am rambursat manual» cer `payments.refund` (verificat din nou pe server, în acțiuni).
 */
export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "payments.read" });
  const { id } = await params;
  const detail = await paymentDetail(getDb(), id);
  if (!detail) notFound();
  const regional = await getSettings().getGroup("regional");
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);
  const canRefund = can(subject, "payments.refund");
  const { payment } = detail;
  const attention = payment.attentionReason ? m.attention[payment.attentionReason] : null;
  const manualRefunds = detail.refunds.filter(
    (refund) =>
      refund.status === "manual_required" ||
      // cerută, trimisă și neconfirmată: se poate confirma manual
      (refund.status === "requested" &&
        refund.confirmedAt === null &&
        refund.failureMessage === null),
  );

  const facts: Array<[string, string]> = [
    [m.detail.order, payment.orderNumber],
    [
      m.detail.provider,
      `${m.providers[payment.provider] ?? payment.provider}${payment.mode ? ` (${m.modes[payment.mode] ?? payment.mode})` : ""}`,
    ],
    [m.detail.amount, money(payment.amountMinor)],
    ...(payment.capturedAmountMinor !== null
      ? ([
          [
            m.detail.captured,
            `${money(payment.capturedAmountMinor)} ${payment.capturedCurrency ?? ""}`.trim(),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(payment.cardLast4
      ? ([[m.detail.card, `•••• ${payment.cardLast4}`]] as Array<[string, string]>)
      : []),
    ...(payment.providerRef
      ? ([[m.detail.providerRef, payment.providerRef]] as Array<[string, string]>)
      : []),
    ...(payment.failureCode
      ? ([[m.detail.failure, payment.failureCode]] as Array<[string, string]>)
      : []),
    [m.detail.date, when(payment.createdAt)],
    ...(payment.capturedAt
      ? ([[m.detail.capturedAt, when(payment.capturedAt)]] as Array<[string, string]>)
      : []),
    [m.detail.refundedTotal, money(payment.refundCommittedMinor)],
    [m.detail.remaining, money(detail.remainingRefundableMinor)],
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/plati"
          className="text-body text-link underline-offset-2 hover:underline"
        >
          {m.detail.back}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title">
            {m.title}: {payment.orderNumber}
          </h1>
          <Badge variant={STATUS_TONE[payment.status] ?? "neutral"} dot>
            {m.paymentStatus[payment.status] ?? payment.status}
          </Badge>
          <span className="text-body text-ink-secondary">{m.attempt(payment.attemptNo)}</span>
        </div>
        {!canRefund && (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {m.readOnly}
          </p>
        )}
      </div>

      {attention && (
        <section
          aria-labelledby="attention-title"
          className="rounded-lg bg-tone-warning-bg p-4 text-tone-warning-fg"
        >
          <h2 id="attention-title" className="text-heading">
            {m.attentionTitle}: {attention.label}
          </h2>
          <p className="mt-1 text-body">{attention.help}</p>
        </section>
      )}

      <Section id="facts">
        <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-label text-ink-secondary">{label}</dt>
              <dd className="break-words tabular-nums" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {canRefund && detail.remainingRefundableMinor > 0 && (
        <Section id="refund" title={m.refund.title}>
          <RefundForm
            paymentId={payment.id}
            remainingMinor={detail.remainingRefundableMinor}
            currency={regional.currency}
            locale={regional.locale}
            canRefund={canRefund}
          />
        </Section>
      )}

      <Section id="refunds" title={m.detail.refundsTitle}>
        {detail.refunds.length === 0 ? (
          <p className="text-body text-ink-secondary">{m.detail.noRefunds}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">{money(refund.amountMinor)}</span>
                  <Badge variant={REFUND_TONE[refund.status] ?? "neutral"} dot>
                    {m.refundStatus[refund.status] ?? refund.status}
                  </Badge>
                  <span className="text-label text-ink-secondary">
                    {m.refundKind[refund.kind] ?? refund.kind} · {when(refund.createdAt)}
                  </span>
                </div>
                <p className="text-body">{refund.reason}</p>
                {refund.failureMessage && (
                  <p className="text-body text-tone-problem-fg">{refund.failureMessage}</p>
                )}
                {refund.manualReference && (
                  <p className="text-label text-ink-secondary">
                    {m.detail.manualReference}: {refund.manualReference}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canRefund && manualRefunds.length > 0 && (
        <Section id="manual" title={m.manual.title} description={m.manual.help}>
          <div className="flex flex-col gap-4">
            {manualRefunds.map((refund) => (
              <div key={refund.id} className="flex flex-col gap-1">
                <span className="text-body font-medium tabular-nums">
                  {money(refund.amountMinor)}
                </span>
                <ManualRefundForm refundId={refund.id} canRefund={canRefund} />
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section id="attempts" title={m.detail.attempts}>
        <ul className="flex flex-col gap-1 text-body">
          {detail.attempts.map((attempt) => (
            <li key={attempt.id}>
              <Link
                className="text-link underline-offset-2 hover:underline"
                href={`/admin/plati/${attempt.id}`}
              >
                {m.attempt(attempt.attemptNo)}
              </Link>{" "}
              · {m.providers[attempt.provider] ?? attempt.provider} ·{" "}
              {m.paymentStatus[attempt.status] ?? attempt.status}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="timeline" title={m.detail.timeline}>
        <ol className="flex flex-col gap-2 text-body">
          {detail.timeline.map((event) => (
            <li key={event.id} className="flex flex-col">
              <span className="text-label text-ink-secondary tabular-nums">
                {when(event.createdAt)}
              </span>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
