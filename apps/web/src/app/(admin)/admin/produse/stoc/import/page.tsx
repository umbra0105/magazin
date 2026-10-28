import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@ecom/core";
import { buttonVariants } from "@ecom/ui";
import { StockImportHistory } from "@/components/admin/inventory/stock-import-history";
import { StockImportPanel } from "@/components/admin/inventory/stock-import-panel";
import { Pager } from "@/components/admin/inventory/stock-parts";
import { requireAdmin } from "@/lib/admin-page";
import { getStockReportImportService } from "@/lib/stock-imports";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.stockImport;

export const metadata: Metadata = { title: m.title };

/** Mărimea maximă a raportului, în MB (aceeași cu `STOCK_REPORT_MAX_BYTES`). */
const MAX_MB = 5;

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Importul «stoc la zi» din SmartBill. Cere `inventory.read` (istoricul pozelor); încărcarea, verificarea și aplicarea
 * apar doar cu `inventory.write` (și ruta de încărcare le verifică din nou). Ecranul face parte din «Stoc»: nu are element
 * propriu în meniu.
 */
export default async function StockImportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "inventory.read" });
  const canWrite = can(subject, "inventory.write");
  const raw = (await searchParams)["pagina"];
  const requested = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? "1") : (raw ?? "1"), 10);
  const history = await getStockReportImportService().history(subject, {
    page: Number.isFinite(requested) ? requested : 1,
  });
  const regional = await getSettings().getGroup("regional");
  const pageCount = Math.max(1, Math.ceil(history.total / history.pageSize));
  const page = Math.min(Number.isFinite(requested) && requested >= 1 ? requested : 1, pageCount);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          <Link href="/admin/produse/stoc" className={buttonVariants({ variant: "outline" })}>
            {m.back}
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canWrite && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
      </header>

      {canWrite && (
        <StockImportPanel timeZone={regional.timezone} locale={regional.locale} maxMb={MAX_MB} />
      )}

      <StockImportHistory
        rows={history.rows.map((row) => ({
          ...row,
          takenAt: row.takenAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }))}
        locale={regional.locale}
        timeZone={regional.timezone}
      />
      <Pager
        page={page}
        pageCount={pageCount}
        hrefFor={(target) =>
          target <= 1 ? "/admin/produse/stoc/import" : `/admin/produse/stoc/import?pagina=${target}`
        }
      />
    </div>
  );
}
