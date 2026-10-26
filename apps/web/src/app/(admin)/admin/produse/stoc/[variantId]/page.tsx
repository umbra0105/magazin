import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ADJUSTMENT_REASONS, ADJUSTMENT_REASON_LABELS, parseStockOverviewQuery } from "@ecom/core";
import { buttonVariants } from "@ecom/ui";
import { MovementsTable } from "@/components/admin/inventory/movements-table";
import { FreshnessBanner, Pager } from "@/components/admin/inventory/stock-parts";
import { requireAdmin } from "@/lib/admin-page";
import { getStockOverviewService } from "@/lib/inventory";
import { availabilityView, kindLabel, quantityText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

export const metadata: Metadata = { title: m.history.breadcrumb };

type SearchParams = Record<string, string | string[] | undefined>;

/** Istoricul mișcărilor unei variante. Cere `inventory.read`; registrul nu se poate modifica din interfață. */
export default async function StockHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "inventory.read" });
  const { variantId } = await params;
  const { page: requestedPage } = parseStockOverviewQuery(await searchParams);
  const service = getStockOverviewService();
  const detail = await service.variant(subject, variantId);
  if (!detail) notFound();
  const history = await service.movements(subject, variantId, {
    warehouseId: detail.warehouse.id,
    ...(requestedPage && { page: requestedPage }),
  });

  const { row } = detail;
  const name = row.variantLabel ? `${row.productTitle} (${row.variantLabel})` : row.productTitle;
  const availability = availabilityView(row);
  const reasonLabels: Record<string, string> = Object.fromEntries(
    ADJUSTMENT_REASONS.map((value) => [value, ADJUSTMENT_REASON_LABELS[value]]),
  );
  const summary = m.history.summary;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse/stoc"
          className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}
        >
          {m.history.back}
        </Link>
        <h1 className="text-2xl font-semibold">{m.history.title(name)}</h1>
        <p className="text-sm text-muted-foreground">{m.history.immutable}</p>
      </header>

      <FreshnessBanner freshness={detail.freshness} />

      <dl className="grid grid-cols-2 gap-3 rounded-md border border-border p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          [summary.sku, row.sku],
          [summary.unit, row.unit.symbol],
          [
            summary.physical,
            row.physical !== null ? quantityText(row.physical, row.unit) : kindLabel(row),
          ],
          [summary.committed, row.committed !== null ? quantityText(row.committed, row.unit) : "—"],
          [summary.reserved, row.reserved !== null ? quantityText(row.reserved, row.unit) : "—"],
          [
            summary.available,
            availability ? `${availability.quantity} = ${availability.steps}` : "—",
          ],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <MovementsTable
        rows={history.rows}
        unit={row.unit}
        timeZone={detail.settings.timeZone}
        reasonLabels={reasonLabels}
      />
      <Pager
        page={history.page}
        pageCount={history.pageCount}
        hrefFor={(target) =>
          `/admin/produse/stoc/${variantId}${target > 1 ? `?pagina=${target}` : ""}`
        }
      />
    </div>
  );
}
