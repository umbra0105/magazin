import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { compareQuantity, formatQuantity, quantityFromTicks } from "@ecom/shared";
import { AccountError, getAccountOrder } from "@ecom/core";
import { getDb } from "@ecom/db";
import { ReturnForm } from "@/components/storefront/account/return-form";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.returns.title };
export const dynamic = "force-dynamic";

/** Inițierea unui retur: doar pentru o comandă a clientului, livrată, în fereastra de retur și cu cantități rămase. */
export default async function NewReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ comanda?: string }>;
}) {
  const { comanda } = await searchParams;
  if (!comanda) redirect("/cont/retururi");
  const { user } = await requireCustomer(`/cont/retururi/nou?comanda=${comanda}`);
  const [format, order] = await Promise.all([
    getAccountFormat(),
    getAccountOrder(getDb(), user, comanda, new Date()).catch((error: unknown) => {
      if (error instanceof AccountError && error.code === "ACCOUNT_ORDER_NOT_FOUND") return null;
      throw error;
    }),
  ]);
  if (!order) notFound();
  if (!order.canRequestReturn || !order.returnWindow.endsAt) redirect(`/cont/comenzi/${order.id}`);
  const lines = order.returnableLines
    .filter((l) => compareQuantity(l.returnable, quantityFromTicks(0n)) > 0)
    .map((l) => ({
      orderLineId: l.orderLineId,
      title: l.title,
      variantTitle: l.variantTitle,
      unitSymbol: l.unitSymbol,
      returnableText: formatQuantity(quantityFromTicks(l.returnable)),
      stepText: formatQuantity(quantityFromTicks(l.step)),
    }));
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/cont/comenzi/${order.id}`}
          className="text-sm font-medium underline underline-offset-4"
        >
          {m.orders.backToList}
        </Link>
        <h1 className="heading-display text-3xl sm:text-4xl">{m.returns.newTitle(order.number)}</h1>
        <p className="max-w-prose text-ink-secondary">
          {m.returns.newLede(format.date(order.returnWindow.endsAt))}
        </p>
      </header>
      <ReturnForm orderId={order.id} lines={lines} />
    </div>
  );
}
