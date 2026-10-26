import Link from "next/link";
import type { StockOverviewRow, StockProductGroup } from "@ecom/core";
import { formatQuantity } from "@ecom/shared/quantity";
import { Badge, buttonVariants } from "@ecom/ui";
import { History } from "lucide-react";
import { formatLocalDateTime } from "@/lib/stock-time";
import {
  availabilityView,
  kindLabel,
  quantityText,
  stateView,
  thresholdTarget,
} from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { AdjustStockButton, type ReasonOption } from "./adjust-stock-dialog";
import { badgeVariant } from "./stock-parts";
import { SetThresholdButton } from "./threshold-dialog";

const m = getMessages().admin.inventory;

/** Setările dialogului «Prag»: limita de sus și pragul global (în pași), de pe server. */
export interface ThresholdSettings {
  max: number;
  globalSteps: number;
}

function displayName(row: StockOverviewRow): string {
  return row.variantLabel ? `${row.productTitle} (${row.variantLabel})` : row.productTitle;
}

/**
 * Tabelul stocului, grupat pe produs: pentru fiecare variantă Fizică (valabilă la …), Angajat, Rezervat, Disponibil în
 * unitate și în pași, Rest nevandabil și starea vizibilă. Negestionatul și digitalul nu au cantități. Acțiunile cer
 * `inventory.write` pentru «Ajustează»; «Istoric» cere doar `inventory.read`.
 */
export function StockTable({
  groups,
  canWrite,
  reasons,
  warehouseId,
  timeZone,
  noteMax,
  threshold,
  rowAttribute = "data-variant-row",
}: {
  groups: readonly StockProductGroup[];
  canWrite: boolean;
  reasons: readonly ReasonOption[];
  warehouseId: string;
  timeZone: string;
  noteMax: number;
  /** Dacă e dat (și există `inventory.write`), rândurile gestionate au butonul «Prag»; lipsă = fără buton (alte ecrane) */
  threshold?: ThresholdSettings;
  /** Atributul `data-…` care marchează rândul unei variante (după SKU); implicit `data-variant-row` */
  rowAttribute?: string;
}) {
  const c = m.columns;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[64rem] text-left text-sm" aria-label={m.listLabel}>
        <thead className="border-b border-border bg-border/30">
          <tr>
            {(
              [
                "product",
                "unit",
                "physical",
                "committed",
                "reserved",
                "available",
                "remainder",
                "state",
              ] as const
            ).map((column) => (
              <th key={column} scope="col" className="p-3 font-medium">
                {c[column]}
              </th>
            ))}
            <th scope="col" className="p-3 text-right font-medium">
              {c.actions}
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody
            key={group.productId}
            data-product={group.productSlug}
            className="border-b border-border last:border-0"
          >
            {group.rows.map((row, index) => (
              <StockRow
                key={row.variantId}
                row={row}
                first={index === 0}
                canWrite={canWrite}
                reasons={reasons}
                warehouseId={warehouseId}
                timeZone={timeZone}
                noteMax={noteMax}
                {...(threshold && { threshold })}
                rowAttribute={rowAttribute}
              />
            ))}
            <GroupTotal group={group} />
          </tbody>
        ))}
      </table>
    </div>
  );
}

function StockRow({
  row,
  first,
  canWrite,
  reasons,
  warehouseId,
  timeZone,
  noteMax,
  threshold,
  rowAttribute,
}: {
  row: StockOverviewRow;
  first: boolean;
  canWrite: boolean;
  reasons: readonly ReasonOption[];
  warehouseId: string;
  timeZone: string;
  noteMax: number;
  threshold?: ThresholdSettings;
  rowAttribute: string;
}) {
  const state = stateView(row);
  const thresholdData =
    canWrite && threshold
      ? thresholdTarget(row, {
          warehouseId,
          name: displayName(row),
          globalSteps: threshold.globalSteps,
        })
      : null;
  const availability = availabilityView(row);
  const name = displayName(row);
  return (
    <tr
      {...{ [rowAttribute]: row.sku }}
      data-kind={row.kind}
      data-state={row.state}
      className={first ? "" : "border-t border-border/60"}
    >
      <th scope="row" className="p-3 align-top font-normal">
        {first && (
          <Link
            href={`/admin/produse/${row.productId}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {row.productTitle}
          </Link>
        )}
        <span className="block text-muted-foreground">
          {row.variantLabel ?? (first ? "" : row.productTitle)}
          <span className="ml-1 text-xs">{row.sku}</span>
        </span>
      </th>
      <td className="p-3 align-top whitespace-nowrap text-muted-foreground" data-cell="unit">
        {m.details.stepUnit(row.unit.symbol, formatQuantity(row.step))}
      </td>
      {row.kind === "managed" &&
      row.physical !== null &&
      row.committed !== null &&
      row.reserved !== null ? (
        <>
          <td className="p-3 align-top" data-cell="physical">
            <span className="font-medium">{quantityText(row.physical, row.unit)}</span>
            <span className="block text-xs text-muted-foreground">
              {!row.inventoried
                ? m.cell.notInventoried
                : row.physicalAsOf
                  ? m.cell.asOf(formatLocalDateTime(row.physicalAsOf, timeZone))
                  : m.cell.noSnapshot}
            </span>
          </td>
          <td className="p-3 align-top" data-cell="committed">
            {quantityText(row.committed, row.unit)}
          </td>
          <td className="p-3 align-top" data-cell="reserved">
            {quantityText(row.reserved, row.unit)}
          </td>
          <td className="p-3 align-top" data-cell="available">
            {availability && (
              <>
                <span className="font-medium">{availability.quantity}</span>
                <span className="block text-xs text-muted-foreground">= {availability.steps}</span>
              </>
            )}
          </td>
          <td className="p-3 align-top" data-cell="remainder">
            {availability?.remainder ?? m.cell.remainderNone}
          </td>
        </>
      ) : (
        <td colSpan={5} className="p-3 align-top text-muted-foreground" data-cell="kind">
          {kindLabel(row)}
          {canWrite && row.kind === "unmanaged" && (
            <span className="block text-xs">{m.cell.manageHint}</span>
          )}
        </td>
      )}
      <td className="p-3 align-top" data-cell="state">
        <Badge variant={badgeVariant(state.tone)} className="whitespace-nowrap">
          {state.label}
        </Badge>
        {state.detail && (
          <span className="mt-1 block text-xs text-muted-foreground">{state.detail}</span>
        )}
      </td>
      <td className="p-3 align-top">
        <div className="flex justify-end gap-1">
          {thresholdData && threshold && (
            <SetThresholdButton target={thresholdData} max={threshold.max} />
          )}
          {canWrite && row.kind === "managed" && (
            <AdjustStockButton
              target={{
                variantId: row.variantId,
                warehouseId,
                name,
                unit: { symbol: row.unit.symbol, decimals: row.unit.decimals },
                physicalText: row.physical !== null ? quantityText(row.physical, row.unit) : "",
                asOf: row.physicalAsOf ? row.physicalAsOf.toISOString() : null,
              }}
              reasons={reasons}
              timeZone={timeZone}
              noteMax={noteMax}
            />
          )}
          {row.kind === "managed" && (
            <Link
              href={`/admin/produse/stoc/${row.variantId}`}
              aria-label={m.actions.historyAria(name)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <History aria-hidden="true" className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">{m.actions.history}</span>
            </Link>
          )}
        </div>
      </td>
    </tr>
  );
}

function GroupTotal({ group }: { group: StockProductGroup }) {
  if (!group.total && !group.totalProblem) return null;
  return (
    <tr
      data-product-total={group.productSlug}
      className="border-t border-border bg-border/20 text-sm"
    >
      <th scope="row" className="p-3 font-medium">
        {m.total.label}
      </th>
      <td />
      {group.total ? (
        <>
          <td className="p-3 font-medium" data-cell="total-physical">
            {quantityText(group.total.physical, group.total.unit)}
          </td>
          <td className="p-3" data-cell="total-committed">
            {quantityText(group.total.committed, group.total.unit)}
          </td>
          <td className="p-3" data-cell="total-reserved">
            {quantityText(group.total.reserved, group.total.unit)}
          </td>
          <td className="p-3 font-medium" data-cell="total-available">
            {quantityText(group.total.available, group.total.unit)}
          </td>
          <td colSpan={3} />
        </>
      ) : (
        <td colSpan={7} className="p-3 text-muted-foreground" data-cell="total-problem">
          {group.totalProblem ? m.total[group.totalProblem] : ""}
        </td>
      )}
    </tr>
  );
}
