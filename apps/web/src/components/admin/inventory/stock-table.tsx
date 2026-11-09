import Link from "next/link";
import type { StockOverviewRow, StockProductGroup } from "@ecom/core";
import { formatQuantity } from "@ecom/shared/quantity";
import {
  Badge,
  RowHeader,
  TBody,
  Table,
  TableCaption,
  Td,
  Th,
  THead,
  Tr,
  buttonVariants,
} from "@ecom/ui";
import { History } from "lucide-react";
import { formatLocalDateTime, formatShortDateTime } from "@/lib/stock-time";
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
 *
 * Prioritatea coloanelor (docs/17 §3): mereu Produs (cu SKU dedesubt), Disponibil, Stare și Acțiuni; de la 48rem lățime
 * de tabel apare Fizică, de la 60rem Angajat și Rezervat, de la 68rem Unitate și pas și Rest nevandabil. Detaliile ascunse se
 * găsesc în «Istoric». Rândul are o linie de valoare plus una de explicație (≈52 px), cu celule numerice pe un singur
 * rând; «Prag» și «Istoric» sunt butoane doar cu pictogramă (nume accesibil și tooltip), «Ajustează» rămâne cu text.
 *
 * Pe telefon (sub 42rem de tabel) tabelul e o listă de carduri (`Table stacked`): numele pe toată lățimea, cu SKU-ul sub el;
 * Disponibil și starea pe aceeași linie; apoi acțiunile (butoane de 44 px). Detaliile nu apar în card.
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
    <Table stacked aria-label={m.listLabel}>
      <TableCaption>{m.listLabel}</TableCaption>
      <THead>
        <Tr className="h-auto">
          <Th>{c.product}</Th>
          <Th priority="detail">{c.unit}</Th>
          <Th numeric priority="secondary">
            {c.physical}
          </Th>
          <Th numeric priority="tertiary">
            {c.committed}
          </Th>
          <Th numeric priority="tertiary">
            {c.reserved}
          </Th>
          <Th numeric>{c.available}</Th>
          <Th numeric priority="detail">
            {c.remainder}
          </Th>
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
      <RowHeader>
        {first && (
          <Link
            href={`/admin/produse/${row.productId}`}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {row.productTitle}
          </Link>
        )}
        <span className="block text-label text-ink-secondary">
          {row.variantLabel ?? (first ? "" : row.productTitle)}
          <span className="ml-1">{row.sku}</span>
        </span>
      </RowHeader>
      <Td priority="detail" className="whitespace-nowrap text-ink-secondary" data-cell="unit">
        {m.details.stepUnit(row.unit.symbol, formatQuantity(row.step))}
      </Td>
      {row.kind === "managed" &&
      row.physical !== null &&
      row.committed !== null &&
      row.reserved !== null ? (
        <>
          <Td numeric priority="secondary" className="whitespace-nowrap" data-cell="physical">
            <span className="font-medium">{quantityText(row.physical, row.unit)}</span>
            <span className="block text-label text-ink-secondary">
              {!row.inventoried ? (
                m.cell.notInventoried
              ) : row.physicalAsOf ? (
                <span title={m.cell.asOf(formatLocalDateTime(row.physicalAsOf, timeZone))}>
                  <span className="sr-only">{m.cell.asOfPrefix} </span>
                  {m.cell.asOfShort(formatShortDateTime(row.physicalAsOf, timeZone))}
                </span>
              ) : (
                <span title={m.cell.noSnapshot}>{m.cell.noSnapshotShort}</span>
              )}
            </span>
          </Td>
          <Td numeric priority="tertiary" className="whitespace-nowrap" data-cell="committed">
            {quantityText(row.committed, row.unit)}
          </Td>
          <Td numeric priority="tertiary" className="whitespace-nowrap" data-cell="reserved">
            {quantityText(row.reserved, row.unit)}
          </Td>
          <Td numeric className="whitespace-nowrap" data-cell="available">
            {availability && (
              <>
                <span className="font-medium">{availability.quantity}</span>
                <span className="block text-label text-ink-secondary group-data-[stacked]/table:@max-2xl/table:ml-1.5 group-data-[stacked]/table:@max-2xl/table:inline">
                  = {availability.steps}
                </span>
              </>
            )}
          </Td>
          <Td numeric priority="detail" className="whitespace-nowrap" data-cell="remainder">
            {availability?.remainder ?? m.cell.remainderNone}
          </Td>
        </>
      ) : (
        <>
          <Td priority="secondary" />
          <Td priority="tertiary" />
          <Td priority="tertiary" />
          <Td
            className="text-right text-label text-ink-secondary group-data-[stacked]/table:@max-2xl/table:text-left"
            data-cell="kind"
            {...(canWrite && row.kind === "unmanaged" && { title: m.cell.manageHint })}
          >
            {/* cel mult două linii (testat la 1024 și 1440 px); sugestia (cum se pornește gestiunea) e în tooltip, nu pe rând */}
            <span className="block">{kindLabel(row)}</span>
          </Td>
          <Td priority="detail" />
        </>
      )}
      <Td data-cell="state">
        <Badge variant={badgeVariant(state.tone)} dot className="whitespace-nowrap">
          {state.label}
        </Badge>
        {state.detail && (
          <span className="mt-1 block text-label text-ink-secondary group-data-[stacked]/table:@max-2xl/table:ml-2 group-data-[stacked]/table:@max-2xl/table:mt-0 group-data-[stacked]/table:@max-2xl/table:inline">
            {state.detail}
          </span>
        )}
      </Td>
      <Td stack="actions" data-cell="actions">
        <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
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
              title={m.actions.history}
              className={buttonVariants({ variant: "outline", size: "icon" })}
            >
              <History aria-hidden="true" className="h-4 w-4" />
            </Link>
          )}
        </div>
      </Td>
    </Tr>
  );
}

function GroupTotal({ group }: { group: StockProductGroup }) {
  if (!group.total && !group.totalProblem) return null;
  const total = group.total;
  return (
    <Tr data-product-total={group.productSlug} className="bg-surface-subtle">
      <RowHeader className="bg-surface-subtle font-medium">
        {m.total.label}
        {group.totalProblem && (
          <span
            className="block text-label font-normal text-ink-secondary"
            data-cell="total-problem"
          >
            {m.total[group.totalProblem]}
          </span>
        )}
      </RowHeader>
      <Td priority="detail" />
      <Td
        numeric
        priority="secondary"
        className="whitespace-nowrap font-medium"
        data-cell="total-physical"
      >
        {total ? quantityText(total.physical, total.unit) : null}
      </Td>
      <Td numeric priority="tertiary" className="whitespace-nowrap" data-cell="total-committed">
        {total ? quantityText(total.committed, total.unit) : null}
      </Td>
      <Td numeric priority="tertiary" className="whitespace-nowrap" data-cell="total-reserved">
        {total ? quantityText(total.reserved, total.unit) : null}
      </Td>
      <Td numeric className="whitespace-nowrap font-medium" data-cell="total-available">
        {total ? quantityText(total.available, total.unit) : null}
      </Td>
      <Td priority="detail" />
      <Td />
      <Td />
    </Tr>
  );
}
