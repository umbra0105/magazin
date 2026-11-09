import Link from "next/link";
import type { StockOverviewRow } from "@ecom/core";
import { Badge, TBody, Table, TableCaption, Td, Th, THead, Tr, buttonVariants } from "@ecom/ui";
import { History } from "lucide-react";
import { historyHref } from "@/lib/stock-url";
import {
  availabilityView,
  badgeVariant,
  lowStockReasonView,
  quantityText,
  thresholdTarget,
  transferTarget,
} from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { AdjustStockButton, type ReasonOption } from "./adjust-stock-dialog";
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
    <Table className="min-w-176" aria-label={m.lowStock.listLabel}>
      <TableCaption>{m.lowStock.listLabel}</TableCaption>
      <THead>
        <Tr className="h-auto">
          <Th className="sticky left-0 z-10 bg-surface-subtle md:static">{c.product}</Th>
          <Th numeric>{c.available}</Th>
          <Th numeric>{c.threshold}</Th>
          <Th>{c.reason}</Th>
          <Th numeric>{c.actions}</Th>
        </Tr>
      </THead>
      <TBody>
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
            <Tr key={row.variantId} data-low-row={row.sku} data-reason={reason?.reason}>
              <th
                scope="row"
                className="sticky left-0 z-10 min-w-40 max-w-56 bg-surface-page px-3 py-2 text-left align-middle font-normal md:static md:max-w-none"
              >
                <Link
                  href={`/admin/produse/${row.productId}`}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {row.productTitle}
                </Link>
                <span className="block text-ink-secondary">
                  {row.variantLabel}
                  <span className={row.variantLabel ? "ml-1 text-label" : "text-label"}>
                    {row.sku}
                  </span>
                </span>
              </th>
              <Td numeric data-cell="available">
                {availability && (
                  <>
                    <span className="font-medium">{availability.quantity}</span>
                    <span className="block text-label text-ink-secondary">
                      = {availability.steps}
                    </span>
                    {availability.remainder && (
                      <span className="block text-label text-ink-secondary">
                        {m.columns.remainder}: {availability.remainder}
                      </span>
                    )}
                  </>
                )}
              </Td>
              <Td numeric data-cell="threshold">
                {target && (
                  <>
                    <span className="font-medium">{target.effectiveText}</span>
                    <span className="block text-label text-ink-secondary">
                      {target.originLabel}
                    </span>
                  </>
                )}
              </Td>
              <Td data-cell="reason">
                {reason && (
                  <Badge variant={badgeVariant(reason.tone)} dot>
                    {reason.label}
                  </Badge>
                )}
              </Td>
              <Td>
                <div className="flex justify-end gap-1">
                  {canWrite && target && <SetThresholdButton target={target} max={thresholdMax} />}
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
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
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
