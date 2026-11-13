import type { StockMovementRow } from "@ecom/core";
import { EmptyState, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { formatLocalDateTime } from "@/lib/stock-time";
import { deltaText, quantityText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.history;

/**
 * Istoricul mișcărilor unei variante, cele mai noi primele. Registrul e imuabil (nicio acțiune de modificare sau ștergere).
 * Motivele vin ca etichete din nucleu (aceleași ca în dialogul de ajustare). `Table stacked` (docs/17 §3): data, tipul, variația
 * fizică și stocul fizic după rămân mereu; motivul și variația angajată de la 48rem, nota și autorul de la 60rem, angajatul
 * după și referința de la 68rem.
 */
export function MovementsTable({
  rows,
  unit,
  timeZone,
  reasonLabels,
}: {
  rows: readonly StockMovementRow[];
  unit: { symbol: string };
  timeZone: string;
  reasonLabels: Readonly<Record<string, string>>;
}) {
  if (rows.length === 0) return <EmptyState title={m.empty} />;
  const c = m.columns;
  const kinds = m.kinds as Record<string, string>;
  return (
    <Table stacked aria-label={m.listLabel}>
      <THead>
        <Tr>
          <Th>{c.effectiveAt}</Th>
          <Th>{c.kind}</Th>
          <Th priority="secondary">{c.reason}</Th>
          <Th priority="tertiary">{c.note}</Th>
          <Th>{c.deltaPhysical}</Th>
          <Th priority="secondary">{c.deltaCommitted}</Th>
          <Th>{c.physicalAfter}</Th>
          <Th priority="detail">{c.committedAfter}</Th>
          <Th priority="tertiary">{c.actor}</Th>
          <Th priority="detail">{c.reference}</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id} data-movement={row.kind} className="align-top">
            <Td stack="title" className="whitespace-nowrap">
              {formatLocalDateTime(row.effectiveAt, timeZone)}
              <span className="block text-label text-ink-secondary">
                {m.recordedAt(formatLocalDateTime(row.createdAt, timeZone))}
              </span>
            </Td>
            <Td>{kinds[row.kind] ?? row.kind}</Td>
            <Td priority="secondary">
              {row.reason ? (reasonLabels[row.reason] ?? row.reason) : ""}
            </Td>
            <Td priority="tertiary" className="wrap-anywhere">
              {row.note ?? ""}
            </Td>
            <Td data-cell="delta-physical">
              {row.deltaPhysical === 0n ? "" : deltaText(row.deltaPhysical, unit)}
            </Td>
            <Td priority="secondary" data-cell="delta-committed">
              {row.deltaCommitted === 0n ? "" : deltaText(row.deltaCommitted, unit)}
            </Td>
            <Td data-cell="physical-after">{quantityText(row.physicalAfter, unit)}</Td>
            <Td priority="detail">{quantityText(row.committedAfter, unit)}</Td>
            <Td priority="tertiary">{row.actorLabel ?? m.system}</Td>
            <Td priority="detail" className="text-ink-secondary wrap-anywhere">
              {row.refType && row.refId ? `${row.refType} ${row.refId}` : ""}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
