import type { Metadata } from "next";
import Link from "next/link";
import {
  ADJUSTMENT_NOTE_MAX,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_SIGN_RULES,
  LOW_STOCK_STEPS_MAX,
  can,
  parseStockOverviewQuery,
} from "@ecom/core";
import { buttonVariants } from "@ecom/ui";
import type { ReasonOption } from "@/components/admin/inventory/adjust-stock-dialog";
import { LowStockTable } from "@/components/admin/inventory/low-stock-table";
import {
  FreshnessBanner,
  LowStockSummary,
  Pager,
  StockFilters,
  ViewSwitch,
} from "@/components/admin/inventory/stock-parts";
import { StockTable, type TransferContext } from "@/components/admin/inventory/stock-table";
import { WarehouseSwitcher } from "@/components/admin/inventory/warehouse-switcher";
import { requireAdmin } from "@/lib/admin-page";
import { getStockOverviewService, getWarehouseChoice } from "@/lib/inventory";
import { stockHref, type StockUrlQuery } from "@/lib/stock-url";
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
  const rawParams = await searchParams;
  const query = parseStockOverviewQuery(rawParams);
  const canWrite = can(subject, "inventory.write");
  const lowView = query.lowStockOnly === true;
  // depozitul ales (13d): doar cu steagul pornit și cel puțin două depozite active; altfel `?depozit=` se ignoră și pagina
  // rămâne exact ca până acum (depozitul implicit, fără selector și fără buton de transfer)
  const choice = await getWarehouseChoice(subject, rawParams["depozit"]);
  const urlQuery: StockUrlQuery = {
    ...query,
    ...(choice.urlCode && { warehouseCode: choice.urlCode }),
  };

  let page;
  try {
    page = await getStockOverviewService().list(subject, {
      ...query,
      ...(choice.selected && { warehouseId: choice.selected.id }),
    });
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

  const transfer: TransferContext | undefined =
    canWrite && choice.visible
      ? {
          sourceName: page.warehouse.name,
          destinations: choice.destinations.map(({ id, name }) => ({ id, name })),
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          {/* importul «stoc la zi» lucrează pe depozitul implicit: într-un alt depozit ales nu se arată */}
          {!choice.urlCode && (
            <Link
              href="/admin/produse/stoc/import"
              className={buttonVariants({ variant: "outline" })}
              data-stock-import-link
            >
              {m.stockImport.open}
            </Link>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canWrite && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
      </header>

      {choice.visible && (
        <WarehouseSwitcher
          query={urlQuery}
          options={choice.options.map(({ code, name, isDefault }) => ({ code, name, isDefault }))}
          value={choice.urlCode ?? ""}
        />
      )}
      <FreshnessBanner freshness={page.freshness} />
      <ViewSwitch query={urlQuery} lowStockTotal={page.lowStock.total} />
      {lowView && (
        <section aria-labelledby="low-stock-heading" className="flex flex-col gap-3">
          <h2 id="low-stock-heading" className="text-lg font-semibold">
            {m.lowStock.heading}
          </h2>
          <p className="text-sm text-muted-foreground">{m.lowStock.hint}</p>
          <LowStockSummary counts={page.lowStock} query={urlQuery} />
        </section>
      )}
      <StockFilters query={urlQuery} />

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
          {...(transfer && { transfer })}
          warehouseCode={choice.urlCode}
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
          {...(transfer && { transfer })}
          warehouseCode={choice.urlCode}
        />
      )}
      <Pager
        page={page.page}
        pageCount={page.pageCount}
        hrefFor={(target) => stockHref(urlQuery, { page: target })}
      />
    </div>
  );
}
