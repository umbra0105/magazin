import Link from "next/link";
import type { StockOverviewRow } from "@ecom/core";
import { Badge, buttonVariants } from "@ecom/ui";
import { History } from "lucide-react";
import { historyHref } from "@/lib/stock-url";
import {
  availabilityView,
  lowStockReasonView,
  quantityText,
  thresholdTarget,
  transferTarget,
} from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { AdjustStockButton, type ReasonOption } from "./adjust-stock-dialog";
import { badgeVariant } from "./stock-parts";
import type { TransferContext } from "./stock-table";
import { SetThresholdButton } from "./threshold-dialog";
import { TransferStockButton } from "./transfer-stock-dialog";

const m = getMessages().admin.inventory;

function displayName(row: StockOverviewRow): string {
  return row.variantLabel ? `${row.productTitle} (${row.variantLabel})` : row.productTitle;
}

/**
 * Vederea «Stoc mic»: o listă PLATĂ de variante (nu grupată pe produs), în ordinea primită de la serviciu (cele mai urgente
 * primele), cu motivul, pragul efectiv și acțiunile: «Prag» și «Ajustează» cer `inventory.write`, «Istoric» doar `inventory.read`.
 */
export function LowStockTable({
  rows,
  canWrite,
  reasons,
  warehouseId,
  timeZone,
  noteMax,
  thresholdMax,
  globalThresholdSteps,
  transfer,
  warehouseCode,
}: {
  rows: readonly StockOverviewRow[];
  canWrite: boolean;
  reasons: readonly ReasonOption[];
  warehouseId: string;
  timeZone: string;
  noteMax: number;
  thresholdMax: number;
  globalThresholdSteps: number;
  /** Dacă e dat, rândurile au butonul «Transferă» (doar cu `inventory.write`) */
  transfer?: TransferContext;
  /** Codul depozitului ales, când nu e cel implicit: intră în legătura «Istoric» */
  warehouseCode?: string | null;
}) {
  const c = m.lowStock.columns;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[44rem] text-left text-sm" aria-label={m.lowStock.listLabel}>
        <thead className="border-b border-border bg-border/30">
          <tr>
            {(["product", "available", "threshold", "reason"] as const).map((column) => (
              <th key={column} scope="col" className="p-3 font-medium">
                {c[column]}
              </th>
            ))}
            <th scope="col" className="p-3 text-right font-medium">
              {c.actions}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const name = displayName(row);
            const availability = availabilityView(row);
            const reason = lowStockReasonView(row);
            const target = thresholdTarget(row, {
              warehouseId,
              name,
              globalSteps: globalThresholdSteps,
            });
            return (
              <tr
                key={row.variantId}
                data-low-row={row.sku}
                data-reason={reason?.reason}
                className="border-t border-border/60 first:border-t-0"
              >
                <th scope="row" className="p-3 align-top font-normal">
                  <Link
                    href={`/admin/produse/${row.productId}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {row.productTitle}
                  </Link>
                  <span className="block text-muted-foreground">
                    {row.variantLabel}
                    <span className={row.variantLabel ? "ml-1 text-xs" : "text-xs"}>{row.sku}</span>
                  </span>
                </th>
                <td className="p-3 align-top" data-cell="available">
                  {availability && (
                    <>
                      <span className="font-medium">{availability.quantity}</span>
                      <span className="block text-xs text-muted-foreground">
                        = {availability.steps}
                      </span>
                      {availability.remainder && (
                        <span className="block text-xs text-muted-foreground">
                          {m.columns.remainder}: {availability.remainder}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="p-3 align-top" data-cell="threshold">
                  {target && (
                    <>
                      <span className="font-medium">{target.effectiveText}</span>
                      <span className="block text-xs text-muted-foreground">
                        {target.originLabel}
                      </span>
                    </>
                  )}
                </td>
                <td className="p-3 align-top" data-cell="reason">
                  {reason && (
                    <Badge variant={badgeVariant(reason.tone)} className="whitespace-nowrap">
                      {reason.label}
                    </Badge>
                  )}
                </td>
                <td className="p-3 align-top">
                  <div className="flex justify-end gap-1">
                    {canWrite && target && (
                      <SetThresholdButton target={target} max={thresholdMax} />
                    )}
                    {canWrite && (
                      <AdjustStockButton
                        target={{
                          variantId: row.variantId,
                          warehouseId,
                          name,
                          unit: { symbol: row.unit.symbol, decimals: row.unit.decimals },
                          physicalText:
                            row.physical !== null ? quantityText(row.physical, row.unit) : "",
                          asOf: row.physicalAsOf ? row.physicalAsOf.toISOString() : null,
                        }}
                        reasons={reasons}
                        timeZone={timeZone}
                        noteMax={noteMax}
                        refreshOnClose
                      />
                    )}
                    {canWrite && transfer && (
                      <TransferButtonFor
                        row={row}
                        name={name}
                        transfer={transfer}
                        warehouseId={warehouseId}
                        noteMax={noteMax}
                      />
                    )}
                    <Link
                      href={historyHref(row.variantId, warehouseCode)}
                      aria-label={m.actions.historyAria(name)}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <History aria-hidden="true" className="h-4 w-4" />
                      <span className="ml-1 hidden sm:inline">{m.actions.history}</span>
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Butonul «Transferă» al unui rând din vederea «Stoc mic»; lista se reîmprospătează la închiderea dialogului. */
function TransferButtonFor({
  row,
  name,
  transfer,
  warehouseId,
  noteMax,
}: {
  row: StockOverviewRow;
  name: string;
  transfer: TransferContext;
  warehouseId: string;
  noteMax: number;
}) {
  const target = transferTarget(row, {
    sourceWarehouseId: warehouseId,
    sourceWarehouseName: transfer.sourceName,
    name,
  });
  if (!target) return null;
  return (
    <TransferStockButton
      target={target}
      destinations={transfer.destinations}
      noteMax={noteMax}
      refreshOnClose
    />
  );
}
