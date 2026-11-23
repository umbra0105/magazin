import type { Metadata } from "next";
import Link from "next/link";
import { listAccountOrders, listCustomerReturns } from "@ecom/core";
import { StoreCard, StorePill, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.nav.dashboard };
export const dynamic = "force-dynamic";

/** Sumarul contului: ultimele comenzi, retururile deschise și acțiunile rapide. */
export default async function AccountDashboardPage() {
  const { user, name } = await requireCustomer("/cont");
  const db = getDb();
  const [format, orders, returns] = await Promise.all([
    getAccountFormat(),
    listAccountOrders(db, user, 1, 3),
    listCustomerReturns(db, user.id),
  ]);
  const open = returns.filter((r) => !["refunded", "rejected", "cancelled"].includes(r.status));
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.dashboard.title(name)}</h1>
        <p className="max-w-prose text-ink-secondary">{m.dashboard.lede}</p>
      </header>

      <section aria-labelledby="recent-orders" className="flex flex-col gap-3">
        <h2 id="recent-orders" className="text-xl font-semibold">
          {m.dashboard.recentOrders}
        </h2>
        {orders.orders.length === 0 ? (
          <p className="text-ink-secondary">{m.dashboard.noOrders}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {orders.orders.map((order) => (
              <li key={order.id}>
                <StoreCard className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex flex-col gap-1">
                    <Link
                      href={`/cont/comenzi/${order.id}`}
                      className="font-semibold underline-offset-4 hover:underline"
                    >
                      {m.orders.number} {order.number}
                    </Link>
                    <span className="text-sm text-ink-secondary">
                      {format.date(order.placedAt)} · {format.money(order.totalMinor)}
                    </span>
                  </div>
                  <StorePill tone={order.status === "cancelled" ? "problem" : "info"}>
                    {m.orderStatus[order.status as keyof typeof m.orderStatus] ?? order.status}
                  </StorePill>
                </StoreCard>
              </li>
            ))}
          </ul>
        )}
        {orders.total > 0 ? (
          <Link href="/cont/comenzi" className="text-sm font-medium underline underline-offset-4">
            {m.dashboard.allOrders}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="open-returns" className="flex flex-col gap-3">
        <h2 id="open-returns" className="text-xl font-semibold">
          {m.dashboard.openReturns}
        </h2>
        {open.length === 0 ? (
          <p className="text-ink-secondary">{m.dashboard.noOpenReturns}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {open.map((r) => (
              <li key={r.id}>
                <StoreCard className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <Link
                    href={`/cont/retururi/${r.id}`}
                    className="font-semibold underline-offset-4 hover:underline"
                  >
                    {m.returns.number(r.number)} · {r.orderNumber}
                  </Link>
                  <StorePill tone="info">{m.returnStatus[r.status] ?? r.status}</StorePill>
                </StoreCard>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="quick-actions" className="flex flex-col gap-3">
        <h2 id="quick-actions" className="text-xl font-semibold">
          {m.dashboard.quickActions}
        </h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/magazin" className={storeButtonVariants({ variant: "primary" })}>
            {m.dashboard.goToShop}
          </Link>
          <Link href="/cont/retururi" className={storeButtonVariants({ variant: "secondary" })}>
            {m.nav.returns}
          </Link>
          <Link href="/cont/adrese" className={storeButtonVariants({ variant: "secondary" })}>
            {m.nav.addresses}
          </Link>
        </div>
      </section>
    </div>
  );
}
