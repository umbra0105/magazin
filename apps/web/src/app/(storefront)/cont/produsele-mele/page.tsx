import type { Metadata } from "next";
import Link from "next/link";
import { listLibrary } from "@ecom/core";
import { StoreCard, StorePill, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().digital.library;

export const metadata: Metadata = { title: m.metaTitle };
export const dynamic = "force-dynamic";

/**
 * Biblioteca produselor digitale ale clientului (Faza 14b): drepturile lui de acces (active sau revocate) și liniile așteptate
 * («În așteptarea plății» / «În așteptarea livrării», la ramburs mixt). Nimic din cheile de stocare nu ajunge aici: biblioteca
 * primește doar DTO-uri fără ele.
 */
export default async function DigitalLibraryPage() {
  const { user } = await requireCustomer("/cont/produsele-mele");
  const [format, library] = await Promise.all([getAccountFormat(), listLibrary(getDb(), user.id)]);
  return (
    <div className="flex flex-col gap-8" data-digital-library>
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.lede}</p>
      </header>

      {library.items.length === 0 && library.pending.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-ink-secondary">{m.empty}</p>
          <Link href="/magazin" className={storeButtonVariants({ variant: "secondary" })}>
            {m.emptyAction}
          </Link>
        </div>
      ) : null}

      {library.items.length > 0 ? (
        <ul className="flex flex-col gap-3" data-digital-items>
          {library.items.map((item) => (
            <li key={item.token}>
              <StoreCard className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={`/cont/produsele-mele/${item.token}`}
                    className="text-lg font-semibold underline-offset-4 hover:underline"
                  >
                    {item.productTitle}
                  </Link>
                  <span className="text-sm text-ink-secondary">
                    {m.order} {item.orderNumber} · {m.granted} {format.date(item.grantedAt)} ·{" "}
                    {m.modules(item.moduleCount)}
                  </span>
                  <span className="text-sm text-ink-secondary">
                    {item.maxDownloads === null || item.remainingDownloads === null
                      ? m.downloadsUnlimited
                      : m.downloadsLeft(item.remainingDownloads, item.maxDownloads)}
                  </span>
                  {item.status === "revoked" && item.revokedReason ? (
                    <span className="text-sm text-tone-problem-fg">
                      {m.revokedReason(item.revokedReason)}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StorePill tone={item.status === "active" ? "success" : "problem"}>
                    {item.status === "active" ? m.statusActive : m.statusRevoked}
                  </StorePill>
                  <Link
                    href={`/cont/produsele-mele/${item.token}`}
                    className={storeButtonVariants({ variant: "primary" })}
                  >
                    {m.open}
                  </Link>
                </div>
              </StoreCard>
            </li>
          ))}
        </ul>
      ) : null}

      {library.pending.length > 0 ? (
        <section aria-labelledby="digital-pending" className="flex flex-col gap-3">
          <h2 id="digital-pending" className="text-xl font-semibold">
            {m.pendingTitle}
          </h2>
          <ul className="flex flex-col gap-3" data-digital-pending>
            {library.pending.map((line) => (
              <li key={`${line.orderNumber}:${line.productTitle}`}>
                <StoreCard className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lg font-semibold">{line.productTitle}</span>
                    <StorePill tone="info">
                      {line.awaiting === "delivery" ? m.awaitingDelivery : m.awaitingPayment}
                    </StorePill>
                  </div>
                  <p className="text-sm text-ink-secondary">
                    {line.awaiting === "delivery"
                      ? m.awaitingDeliveryText(line.orderNumber)
                      : m.awaitingPaymentText(line.orderNumber)}
                  </p>
                </StoreCard>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
