import Link from "next/link";
import type { StockOverviewRow, StockProductGroup } from "@ecom/core";
import { formatQuantity } from "@ecom/shared/quantity";
import { Badge, TBody, Table, TableCaption, Td, Th, THead, Tr, buttonVariants } from "@ecom/ui";
import { History } from "lucide-react";
import { formatLocalDateTime } from "@/lib/stock-time";
import { historyHref } from "@/lib/stock-url";
import {
  availabilityView,
  badgeVariant,
  kindLabel,
  quantityText,
  stateView,
  thresholdTarget,
  transferTarget,
} from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { AdjustStockButton, type ReasonOption } from "./adjust-stock-dialog";
import { SetThresholdButton } from "./threshold-dialog";
import { TransferStockButton, type TransferDestination } from "./transfer-stock-dialog";

const m = getMessages().admin.inventory;

/**
 * Transferul între depozite (13d): numele depozitului afișat (sursa) și destinațiile. Îl dă pagina DOAR cu steagul
 * de multi-depozit pornit, cel puțin două depozite active și `inventory.write`; lipsă = fără buton «Transferă».
 */
export interface TransferContext {
  sourceName: string;
  destinations: readonly TransferDestination[];
}

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
  transfer,
  warehouseCode,
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
  /** Dacă e dat, rândurile gestionate au butonul «Transferă» (doar cu `inventory.write`) */
  transfer?: TransferContext;
  /** Codul depozitului ales, când nu e cel implicit: intră în legătura «Istoric» */
  warehouseCode?: string | null;
  /** Atributul `data-…` care marchează rândul unei variante (după SKU); implicit `data-variant-row` */
  rowAttribute?: string;
}) {
  const c = m.columns;
  return (
    <Table className="min-w-256" aria-label={m.listLabel}>
      <TableCaption>{m.listLabel}</TableCaption>
      <THead>
        <Tr className="h-auto">
          <Th className={STICKY_HEAD}>{c.product}</Th>
          <Th>{c.unit}</Th>
          {(["physical", "committed", "reserved", "available", "remainder"] as const).map(
            (column) => (
              <Th key={column} numeric>
                {c[column]}
              </Th>
            ),
          )}
          <Th>{c.state}</Th>
          <Th numeric>{c.actions}</Th>
        </Tr>
      </THead>
      {groups.map((group) => (
        <TBody key={group.productId} data-product={group.productSlug}>
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
              {...(transfer && { transfer })}
              warehouseCode={warehouseCode ?? null}
              rowAttribute={rowAttribute}
            />
          ))}
          <GroupTotal group={group} />
        </TBody>
      ))}
    </Table>
  );
}

/**
 * Prima coloană (produsul) rămâne pe loc la derulare orizontală pe telefon (docs/17 §3), cu fundal propriu ca să nu se vadă
 * celulele din spate; de la `md` în sus tabelul încape sau derulează normal.
 */
const STICKY_HEAD = "sticky left-0 z-10 bg-surface-subtle md:static";
const STICKY_CELL = "sticky left-0 z-10 min-w-40 max-w-56 md:static md:max-w-none";

function StockRow({
  row,
  first,
  canWrite,
  reasons,
  warehouseId,
  timeZone,
  noteMax,
  threshold,
  transfer,
  warehouseCode,
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
  transfer?: TransferContext;
  warehouseCode: string | null;
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
  const transferData =
    canWrite && transfer
      ? transferTarget(row, {
          sourceWarehouseId: warehouseId,
          sourceWarehouseName: transfer.sourceName,
          name,
        })
      : null;
  return (
    <Tr {...{ [rowAttribute]: row.sku }} data-kind={row.kind} data-state={row.state}>
      <th
        scope="row"
        className={`${STICKY_CELL} bg-surface-page px-3 py-2 text-left align-middle font-normal`}
      >
        {first && (
          <Link
            href={`/admin/produse/${row.productId}`}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {row.productTitle}
          </Link>
        )}
        <span className="block text-ink-secondary">
          {row.variantLabel ?? (first ? "" : row.productTitle)}
          <span className="ml-1 text-label">{row.sku}</span>
        </span>
      </th>
      <Td className="whitespace-nowrap text-ink-secondary" data-cell="unit">
        {m.details.stepUnit(row.unit.symbol, formatQuantity(row.step))}
      </Td>
      {row.kind === "managed" &&
      row.physical !== null &&
      row.committed !== null &&
      row.reserved !== null ? (
        <>
          <Td numeric data-cell="physical">
            <span className="font-medium">{quantityText(row.physical, row.unit)}</span>
            <span className="block text-label text-ink-secondary">
              {!row.inventoried
                ? m.cell.notInventoried
                : row.physicalAsOf
                  ? m.cell.asOf(formatLocalDateTime(row.physicalAsOf, timeZone))
                  : m.cell.noSnapshot}
            </span>
          </Td>
          <Td numeric data-cell="committed">
            {quantityText(row.committed, row.unit)}
          </Td>
          <Td numeric data-cell="reserved">
            {quantityText(row.reserved, row.unit)}
          </Td>
          <Td numeric data-cell="available">
            {availability && (
              <>
                <span className="font-medium">{availability.quantity}</span>
                <span className="block text-label text-ink-secondary">= {availability.steps}</span>
              </>
            )}
          </Td>
          <Td numeric data-cell="remainder">
            {availability?.remainder ?? m.cell.remainderNone}
          </Td>
        </>
      ) : (
        <Td colSpan={5} className="text-ink-secondary" data-cell="kind">
          {kindLabel(row)}
          {canWrite && row.kind === "unmanaged" && (
            <span className="block text-label">{m.cell.manageHint}</span>
          )}
        </Td>
      )}
      <Td data-cell="state">
        <Badge variant={badgeVariant(state.tone)} dot>
          {state.label}
        </Badge>
        {state.detail && (
          <span className="mt-1 block text-label text-ink-secondary">{state.detail}</span>
        )}
      </Td>
      <Td>
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
          {transferData && transfer && (
            <TransferStockButton
              target={transferData}
              destinations={transfer.destinations}
              noteMax={noteMax}
            />
          )}
          {row.kind === "managed" && (
            <Link
              href={historyHref(row.variantId, warehouseCode)}
              aria-label={m.actions.historyAria(name)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <History aria-hidden="true" className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">{m.actions.history}</span>
            </Link>
          )}
        </div>
      </Td>
    </Tr>
  );
}

function GroupTotal({ group }: { group: StockProductGroup }) {
  if (!group.total && !group.totalProblem) return null;
  return (
    <Tr data-product-total={group.productSlug} className="bg-surface-subtle">
      <th
        scope="row"
        className={`${STICKY_CELL} bg-surface-subtle px-3 py-2 text-left align-middle font-medium`}
      >
        {m.total.label}
      </th>
      <Td />
      {group.total ? (
        <>
          <Td numeric className="font-medium" data-cell="total-physical">
            {quantityText(group.total.physical, group.total.unit)}
          </Td>
          <Td numeric data-cell="total-committed">
            {quantityText(group.total.committed, group.total.unit)}
          </Td>
          <Td numeric data-cell="total-reserved">
            {quantityText(group.total.reserved, group.total.unit)}
          </Td>
          <Td numeric className="font-medium" data-cell="total-available">
            {quantityText(group.total.available, group.total.unit)}
          </Td>
          <Td colSpan={3} />
        </>
      ) : (
        <Td colSpan={7} className="text-ink-secondary" data-cell="total-problem">
          {group.totalProblem ? m.total[group.totalProblem] : ""}
        </Td>
      )}
    </Tr>
  );
}
