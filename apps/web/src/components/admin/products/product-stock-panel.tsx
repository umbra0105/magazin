import Link from "next/link";
import { groupStockRows, type ProductStockView } from "@ecom/core";
import { Badge, buttonVariants } from "@ecom/ui";
import type { ReasonOption } from "@/components/admin/inventory/adjust-stock-dialog";
import { badgeVariant } from "@/components/admin/inventory/stock-parts";
import { StockTable } from "@/components/admin/inventory/stock-table";
import { kindLabel, stateView } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const t = getMessages().admin.products.editor.stock.quantities;

/**
 * Cantitățile pe variante din tabul Stoc al produsului (componentă de SERVER: citește stocul prin `StockOverviewService`).
 * Cu `inventory.read`: același tabel ca în «Stoc» (Fizică, Angajat, Rezervat, Disponibil în unitate și în pași, rest nevandabil,
 * stare), cu «Ajustează» (doar cu `inventory.write`) și «Istoric». Fără `inventory.read`: doar starea fiecărei variante,
 * fără nicio cantitate (serverul le-a redactat deja).
 */
export function ProductStockPanel({
  view,
  canWrite,
  reasons,
  timeZone,
  noteMax,
}: {
  view: ProductStockView | null;
  canWrite: boolean;
  reasons: readonly ReasonOption[];
  timeZone: string;
  noteMax: number;
}) {
  if (!view) {
    return (
      <section aria-labelledby="stock-quantities-heading" className="flex flex-col gap-2">
        <h3 id="stock-quantities-heading" className="text-base font-semibold">
          {t.heading}
        </h3>
        <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
          {t.noWarehouse}
        </p>
      </section>
    );
  }
  const first = view.rows[0];
  return (
    <section
      aria-labelledby="stock-quantities-heading"
      data-stock-quantities
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="stock-quantities-heading" className="text-base font-semibold">
            {t.heading}
          </h3>
          <p className="text-sm text-muted-foreground">{t.warehouse(view.warehouse.name)}</p>
        </div>
        {view.canSeeQuantities && first && (
          <Link
            href={`/admin/produse/stoc?q=${encodeURIComponent(first.sku)}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {t.openInStock}
          </Link>
        )}
      </div>
      {view.canSeeQuantities ? (
        <StockTable
          groups={groupStockRows(view.rows)}
          canWrite={canWrite}
          reasons={reasons}
          warehouseId={view.warehouse.id}
          timeZone={timeZone}
          noteMax={noteMax}
          rowAttribute="data-product-stock-row"
        />
      ) : (
        <>
          <p
            role="note"
            data-stock-no-quantities
            className="rounded-md border border-border bg-border/30 p-3 text-sm"
          >
            {t.noAccess}
          </p>
          <ul className="flex flex-col gap-2">
            {view.rows.map((row) => {
              const state = stateView(row);
              return (
                <li
                  key={row.variantId}
                  data-variant-state-row={row.sku}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <span className="font-medium">{row.sku}</span>
                  {row.variantLabel && (
                    <span className="text-muted-foreground">{row.variantLabel}</span>
                  )}
                  <span className="text-muted-foreground">{kindLabel(row)}</span>
                  <Badge variant={badgeVariant(state.tone)}>{state.label}</Badge>
                  {state.detail && <span className="text-muted-foreground">{state.detail}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
