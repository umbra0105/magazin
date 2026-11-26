import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomerReturn, ReturnError, formatCompanyAddress } from "@ecom/core";
import { StoreCard, StorePill } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { CancelReturnButton } from "@/components/storefront/account/cancel-return-button";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.returns.title };
export const dynamic = "force-dynamic";

/** Detaliul unui retur: starea, produsele, AWB-ul de retur și instrucțiunile, cronologia (doar evenimente vizibile clientului). */
export default async function AccountReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCustomer(`/cont/retururi/${id}`);
  const [format, company, ret] = await Promise.all([
    getAccountFormat(),
    getSettings().getGroup("company"),
    getCustomerReturn(getDb(), user.id, id).catch((error: unknown) => {
      if (error instanceof ReturnError && error.code === "RETURN_NOT_FOUND") return null;
      throw error;
    }),
  ]);
  if (!ret) notFound();
  // retur închis fără bani (produse plătite integral cu puncte): singurul retur rambursat cu 0 lei
  const pointsOnly =
    ret.status === "refunded" &&
    ret.refundedProductsMinor === 0 &&
    (ret.refundedShippingMinor ?? 0) === 0;
  const address =
    company.address.street.trim() !== "" || company.address.city.trim() !== ""
      ? formatCompanyAddress(company.address)
      : "";
  const showSendTo = ["approved", "awaiting_shipment"].includes(ret.status) && address !== "";
  return (
    <div className="flex flex-col gap-8" data-account-return>
      <header className="flex flex-col gap-2">
        <Link href="/cont/retururi" className="text-sm font-medium underline underline-offset-4">
          {m.nav.returns}
        </Link>
        <h1 className="heading-display text-3xl sm:text-4xl">{m.returns.number(ret.number)}</h1>
        <p className="flex flex-wrap items-center gap-2 text-ink-secondary">
          {m.returns.forOrder}{" "}
          <Link href={`/cont/comenzi/${ret.order.id}`} className="underline underline-offset-4">
            {ret.order.number}
          </Link>
          · {m.returns.requested} {format.dateTime(ret.requestedAt)}
          <StorePill
            tone={
              ret.status === "rejected" ? "problem" : ret.status === "refunded" ? "success" : "info"
            }
          >
            {m.returnStatus[ret.status] ?? ret.status}
          </StorePill>
        </p>
        <p className="max-w-prose">
          {pointsOnly ? m.returns.closedWithoutMoney : m.returns.nextStep[ret.status]}
        </p>
      </header>

      {ret.status === "rejected" && ret.rejectReason ? (
        <p role="note" className="rounded-card bg-tone-problem-bg p-4 text-tone-problem-fg">
          {m.returns.rejectReason}: {ret.rejectReason}
        </p>
      ) : null}

      {ret.status === "refunded" && ret.refundedProductsMinor !== null ? (
        <div role="note" className="rounded-card bg-tone-success-bg p-4 text-tone-success-fg">
          {pointsOnly ? (
            <p className="font-medium" data-return-points-only>
              {m.returns.refundedPoints}
            </p>
          ) : (
            <>
              <p className="font-medium">
                {m.returns.refunded(
                  format.money(ret.refundedProductsMinor + (ret.refundedShippingMinor ?? 0)),
                )}
              </p>
              <p className="text-sm">{m.returns.refundNote}</p>
            </>
          )}
        </div>
      ) : null}

      {showSendTo || ret.returnAwb ? (
        <StoreCard className="flex flex-col gap-2 p-4">
          {showSendTo ? (
            <p>
              <span className="font-semibold">{m.returns.sendTo}:</span> {address}
            </p>
          ) : null}
          {ret.returnAwb ? (
            <p data-return-awb>
              <span className="font-semibold">{m.returns.yourAwb}:</span>{" "}
              <span className="font-mono">{ret.returnAwb}</span>
              {ret.returnCarrier ? ` · ${m.returns.carrier} ${ret.returnCarrier}` : ""}
              {ret.returnTrackingUrl ? (
                <>
                  {" · "}
                  <a
                    href={ret.returnTrackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {m.returns.tracking}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
        </StoreCard>
      ) : null}

      <section aria-labelledby="return-items" className="flex flex-col gap-3">
        <h2 id="return-items" className="text-xl font-semibold">
          {m.returns.items}
        </h2>
        <StoreCard className="p-4">
          <ul className="flex flex-col divide-y divide-line-input">
            {ret.items.map((i) => (
              <li key={i.id} className="flex flex-col gap-1 py-3">
                <span className="font-medium">{i.title}</span>
                {i.variantTitle ? (
                  <span className="text-sm text-ink-secondary">{i.variantTitle}</span>
                ) : null}
                <span className="text-sm text-ink-secondary">
                  {i.requestedQty} {i.unitSymbol} ·{" "}
                  {m.returnReason[i.reasonCode as keyof typeof m.returnReason] ?? i.reasonCode}
                  {i.reasonText ? ` (${i.reasonText})` : ""}
                </span>
                {i.acceptedQty !== null ? (
                  <span className="text-sm">
                    {m.returns.accepted}: {i.acceptedQty} {i.unitSymbol}
                    {i.condition
                      ? ` · ${m.returnCondition[i.condition as keyof typeof m.returnCondition] ?? i.condition}`
                      : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </StoreCard>
        {ret.customerNote ? <p className="text-sm text-ink-secondary">{ret.customerNote}</p> : null}
      </section>

      <section aria-labelledby="return-timeline" className="flex flex-col gap-3">
        <h2 id="return-timeline" className="text-xl font-semibold">
          {m.returns.timeline}
        </h2>
        <ol className="flex flex-col gap-3 border-l-2 border-line-input pl-4" data-timeline>
          {ret.events.map((e, i) => (
            <li key={`${e.type}-${i}`} className="flex flex-col">
              <span className="font-medium">{m.returnEvent[e.type] ?? e.type}</span>
              <span className="text-sm text-ink-secondary">{format.dateTime(e.at)}</span>
            </li>
          ))}
        </ol>
      </section>

      {ret.canCancel ? <CancelReturnButton returnId={ret.id} /> : null}
    </div>
  );
}
