import type { Metadata } from "next";
import Link from "next/link";
import { customerLoyaltyOverview, type LoyaltyHistoryRow } from "@ecom/core";
import { getDb } from "@ecom/db";
import { pluralRo } from "@ecom/shared";
import { StoreCard } from "@ecom/ui";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { requireFeature } from "@/lib/features";
import { getMessages } from "@/messages";

const text = getMessages().account.points;

export const metadata: Metadata = { title: text.title };
export const dynamic = "force-dynamic";

const points = (count: number) => pluralRo(count, "punct", "puncte", "de puncte");

/**
 * Punctele clientului autentificat (Faza 15b): sold, valoare în lei, următorul lot care expiră, punctele în așteptare cu data și
 * istoricul. Datele se citesc DOAR pentru utilizatorul din sesiune. Motivul ajustărilor făcute de magazin nu se arată.
 */
export default async function AccountPointsPage() {
  await requireFeature("loyalty");
  const { user } = await requireCustomer("/cont/puncte");
  const [format, overview] = await Promise.all([
    getAccountFormat(),
    customerLoyaltyOverview(getDb(), user.id, new Date()),
  ]);
  // pagina comenzii verifică singură proprietatea (o comandă străină dă 404)
  const orderCell = (row: LoyaltyHistoryRow) =>
    row.orderId && row.orderNumber ? (
      <Link href={`/cont/comenzi/${row.orderId}`} className="underline underline-offset-4">
        {row.orderNumber}
      </Link>
    ) : (
      "—"
    );
  return (
    <div className="flex flex-col gap-8" data-account-points>
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{text.title}</h1>
        <p className="max-w-prose text-ink-secondary">{text.lede}</p>
      </header>

      {overview.earns ? null : (
        <p className="rounded-card bg-card p-4" data-points-partner>
          <span className="font-semibold">{text.partner}</span>{" "}
          {overview.balance > 0 ? text.partnerKeeps : null}
        </p>
      )}

      <StoreCard className="flex flex-col gap-3 p-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-secondary">{text.balance}</dt>
            <dd className="text-3xl font-semibold tabular-nums" data-points-total>
              {overview.balance < 0 ? overview.balance : overview.spendable}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-secondary">{text.value}</dt>
            <dd className="text-3xl font-semibold tabular-nums" data-points-value>
              {format.money(overview.valueMinor)}
            </dd>
          </div>
        </dl>
        {overview.balance < 0 ? (
          <p className="text-sm" data-points-negative>
            {text.negative}
          </p>
        ) : null}
        <p className="text-sm text-ink-secondary" data-points-expiry>
          {overview.nextExpiry
            ? text.nextExpiry(
                points(overview.nextExpiry.points),
                format.date(overview.nextExpiry.expiresAt),
              )
            : text.noExpiry}
        </p>
      </StoreCard>

      <section aria-labelledby="points-pending" className="flex flex-col gap-3">
        <h2 id="points-pending" className="text-xl font-semibold">
          {text.pendingTitle}
        </h2>
        {overview.pending.length === 0 ? (
          <p className="text-ink-secondary">{text.pendingNone}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-points-pending>
            {overview.pending.map((row) => (
              <li key={row.orderId}>
                {text.pendingRow(points(row.points), row.orderNumber, format.date(row.availableAt))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="points-history" className="flex flex-col gap-3">
        <h2 id="points-history" className="text-xl font-semibold">
          {text.historyTitle}
        </h2>
        {overview.history.length === 0 ? (
          <p className="text-ink-secondary">{text.historyEmpty}</p>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-labelledby="points-history"
          >
            <table className="w-full min-w-lg border-collapse text-sm" data-points-history>
              <thead>
                <tr className="border-b border-line-input text-left">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    {text.columns.date}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    {text.columns.what}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    {text.columns.order}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">
                    {text.columns.points}
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    {text.columns.balance}
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.history.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-line-subtle"
                    data-points-row={row.type}
                  >
                    <td className="py-2 pr-3">{format.date(row.createdAt)}</td>
                    <td className="py-2 pr-3">{text.types[row.type] ?? row.type}</td>
                    <td className="py-2 pr-3">{orderCell(row)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {row.points > 0 ? `+${row.points}` : row.points}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
