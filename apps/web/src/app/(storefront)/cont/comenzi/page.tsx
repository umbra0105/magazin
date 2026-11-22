import type { Metadata } from "next";
import Link from "next/link";
import { listAccountOrders } from "@ecom/core";
import { StoreCard, StorePill, storeButtonVariants } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;
const PAGE_SIZE = 10;

export const metadata: Metadata = { title: m.orders.title };
export const dynamic = "force-dynamic";

/** Istoricul comenzilor clientului: listă paginată; comenzile de oaspete apar doar pentru emailul verificat al contului. */
export default async function AccountOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string }>;
}) {
  const { pagina } = await searchParams;
  const page = Math.max(1, Number.parseInt(pagina ?? "1", 10) || 1);
  const { user } = await requireCustomer("/cont/comenzi");
  const [format, list] = await Promise.all([
    getAccountFormat(),
    listAccountOrders(getDb(), user, page, PAGE_SIZE),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  return (
    <div className="flex flex-col gap-6">
      <h1 className="heading-display text-3xl sm:text-4xl">{m.orders.title}</h1>
      {list.orders.length === 0 ? (
        <p className="text-ink-secondary">{m.orders.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.orders.map((order) => (
            <li key={order.id}>
              <StoreCard className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="flex flex-col gap-1">
                  <Link
                    href={`/cont/comenzi/${order.id}`}
                    className="text-lg font-semibold underline-offset-4 hover:underline"
                  >
                    {m.orders.number} {order.number}
                  </Link>
                  <span className="text-sm text-ink-secondary">
                    {m.orders.placed} {format.date(order.placedAt)} ·{" "}
                    {m.orders.items(order.lineCount)}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <StorePill tone={order.status === "cancelled" ? "problem" : "info"}>
                      {m.orderStatus[order.status as keyof typeof m.orderStatus] ?? order.status}
                    </StorePill>
                    <StorePill tone={order.paymentStatus === "paid" ? "success" : "warning"}>
                      {m.paymentStatus[order.paymentStatus as keyof typeof m.paymentStatus] ??
                        order.paymentStatus}
                    </StorePill>
                    <StorePill tone="neutral">
                      {m.fulfillmentStatus[
                        order.fulfillmentStatus as keyof typeof m.fulfillmentStatus
                      ] ?? order.fulfillmentStatus}
                    </StorePill>
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-lg font-semibold">{format.money(order.totalMinor)}</span>
                  <Link
                    href={`/cont/comenzi/${order.id}`}
                    className={storeButtonVariants({ variant: "secondary" })}
                  >
                    {m.orders.view}
                  </Link>
                </div>
              </StoreCard>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav aria-label={m.orders.page(list.page, pages)} className="flex items-center gap-3">
          {list.page > 1 ? (
            <Link
              href={`/cont/comenzi?pagina=${list.page - 1}`}
              className={storeButtonVariants({ variant: "secondary" })}
            >
              {m.orders.previous}
            </Link>
          ) : null}
          <span className="text-sm text-ink-secondary">{m.orders.page(list.page, pages)}</span>
          {list.page < pages ? (
            <Link
              href={`/cont/comenzi?pagina=${list.page + 1}`}
              className={storeButtonVariants({ variant: "secondary" })}
            >
              {m.orders.next}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
