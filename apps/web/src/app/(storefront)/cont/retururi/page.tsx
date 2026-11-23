import type { Metadata } from "next";
import Link from "next/link";
import { listAccountOrders, listCustomerReturns } from "@ecom/core";
import { StoreCard, StorePill, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.returns.title };
export const dynamic = "force-dynamic";

/** Retururile clientului și accesul la inițierea unui retur nou (din comenzile lui livrate). */
export default async function AccountReturnsPage() {
  const { user } = await requireCustomer("/cont/retururi");
  const db = getDb();
  const [format, returns, orders] = await Promise.all([
    getAccountFormat(),
    listCustomerReturns(db, user.id),
    listAccountOrders(db, user, 1, 10),
  ]);
  const delivered = orders.orders.filter((o) => o.fulfillmentStatus === "delivered");
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.returns.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.returns.lede}</p>
      </header>

      {returns.length === 0 ? (
        <p className="text-ink-secondary">{m.returns.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {returns.map((r) => (
            <li key={r.id}>
              <StoreCard className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex flex-col gap-1">
                  <Link
                    href={`/cont/retururi/${r.id}`}
                    className="text-lg font-semibold underline-offset-4 hover:underline"
                  >
                    {m.returns.number(r.number)}
                  </Link>
                  <span className="text-sm text-ink-secondary">
                    {m.returns.forOrder} {r.orderNumber} · {m.returns.requested}{" "}
                    {format.date(r.requestedAt)}
                  </span>
                </div>
                <StorePill
                  tone={
                    r.status === "rejected"
                      ? "problem"
                      : r.status === "refunded"
                        ? "success"
                        : "info"
                  }
                >
                  {m.returnStatus[r.status] ?? r.status}
                </StorePill>
              </StoreCard>
            </li>
          ))}
        </ul>
      )}

      {delivered.length > 0 ? (
        <section aria-labelledby="start-return" className="flex flex-col gap-3">
          <h2 id="start-return" className="text-xl font-semibold">
            {m.returns.startFor}
          </h2>
          <ul className="flex flex-col gap-2">
            {delivered.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3">
                <span>
                  {m.orders.number} {o.number} · {format.date(o.placedAt)}
                </span>
                <Link
                  href={`/cont/comenzi/${o.id}`}
                  className={storeButtonVariants({ variant: "secondary" })}
                >
                  {m.orders.view}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
