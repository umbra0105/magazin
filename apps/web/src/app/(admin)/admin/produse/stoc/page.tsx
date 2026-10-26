import type { Metadata } from "next";
import {
  ADJUSTMENT_NOTE_MAX,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_SIGN_RULES,
  LOW_STOCK_STEPS_MAX,
  can,
  parseStockOverviewQuery,
} from "@ecom/core";
import type { ReasonOption } from "@/components/admin/inventory/adjust-stock-dialog";
import { LowStockTable } from "@/components/admin/inventory/low-stock-table";
import {
  FreshnessBanner,
  LowStockSummary,
  Pager,
  StockFilters,
  ViewSwitch,
} from "@/components/admin/inventory/stock-parts";
import { StockTable } from "@/components/admin/inventory/stock-table";
import { requireAdmin } from "@/lib/admin-page";
import { getStockOverviewService } from "@/lib/inventory";
import { stockHref } from "@/lib/stock-url";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Ecranul de stoc. Cere `inventory.read`; «Ajustează» apare doar cu `inventory.write` (și acțiunea de pe server o verifică
 * din nou). Filtrele și pagina sunt în adresă (`?q=&tip=&stare=&filtru=stoc-mic&pagina=`), deci pagina se poate partaja și
 * reîncărca. «Stoc mic» e o VEDERE a acestei pagini (filtrul «Doar stoc mic», ordonat după urgență, cu motiv, prag și numărători),
 * nu o pagină separată; «Prag» cere `inventory.write`.
 */
export default async function StockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const subject = await requireAdmin({ permission: "inventory.read" });
  const query = parseStockOverviewQuery(await searchParams);
  const canWrite = can(subject, "inventory.write");
  const lowView = query.lowStockOnly === true;

  let page;
  try {
    page = await getStockOverviewService().list(subject, query);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "STOCK_NO_WAREHOUSE") {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          <p role="alert" className="rounded-md border border-danger p-3 text-sm">
            {m.noWarehouse}
          </p>
        </div>
      );
    }
    throw error;
  }

  const reasons: ReasonOption[] = ADJUSTMENT_REASONS.map((value) => ({
    value,
    label: ADJUSTMENT_REASON_LABELS[value],
    rule: ADJUSTMENT_SIGN_RULES[value],
  }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canWrite && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
      </header>

      <FreshnessBanner
        freshness={page.freshness}
        timeZone={page.settings.timeZone}
        staleHours={page.settings.snapshotStaleHours}
      />
      <ViewSwitch query={query} lowStockTotal={page.lowStock.total} />
      {lowView && (
        <section aria-labelledby="low-stock-heading" className="flex flex-col gap-3">
          <h2 id="low-stock-heading" className="text-lg font-semibold">
            {m.lowStock.heading}
          </h2>
          <p className="text-sm text-muted-foreground">{m.lowStock.hint}</p>
          <LowStockSummary counts={page.lowStock} />
        </section>
      )}
      <StockFilters query={query} />

      <p role="status" className="text-sm text-muted-foreground" data-result-count={page.total}>
        {m.resultCount(page.total)}
      </p>
      {page.truncated && (
        <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
          {m.truncated(5000)}
        </p>
      )}

      {page.rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {lowView ? m.lowStock.empty : m.empty}
        </p>
      ) : lowView ? (
        <LowStockTable
          rows={page.rows}
          canWrite={canWrite}
          reasons={reasons}
          warehouseId={page.warehouse.id}
          timeZone={page.settings.timeZone}
          noteMax={ADJUSTMENT_NOTE_MAX}
          thresholdMax={LOW_STOCK_STEPS_MAX}
          globalThresholdSteps={page.settings.lowStockSteps}
        />
      ) : (
        <StockTable
          groups={page.groups}
          canWrite={canWrite}
          reasons={reasons}
          warehouseId={page.warehouse.id}
          timeZone={page.settings.timeZone}
          noteMax={ADJUSTMENT_NOTE_MAX}
          threshold={{ max: LOW_STOCK_STEPS_MAX, globalSteps: page.settings.lowStockSteps }}
        />
      )}
      <Pager
        page={page.page}
        pageCount={page.pageCount}
        hrefFor={(target) => stockHref(query, { page: target })}
      />
    </div>
  );
}
