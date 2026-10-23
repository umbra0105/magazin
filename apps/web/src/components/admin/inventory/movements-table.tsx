import type { StockMovementRow } from "@ecom/core";
import { formatLocalDateTime } from "@/lib/stock-time";
import { deltaText, quantityText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.history;

/**
 * Istoricul mișcărilor unei variante, cele mai noi primele. Registrul e imuabil (nicio acțiune de modificare sau ștergere).
 * Motivele vin ca etichete din nucleu (aceleași ca în dialogul de ajustare).
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
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
        {m.empty}
      </p>
    );
  }
  const c = m.columns;
  const kinds = m.kinds as Record<string, string>;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[56rem] text-left text-sm" aria-label={m.listLabel}>
        <thead className="border-b border-border bg-border/30">
          <tr>
            {(
              [
                "effectiveAt",
                "kind",
                "reason",
                "note",
                "deltaPhysical",
                "deltaCommitted",
                "physicalAfter",
                "committedAfter",
                "actor",
                "reference",
              ] as const
            ).map((column) => (
              <th key={column} scope="col" className="p-3 font-medium">
                {c[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-movement={row.kind}
              className="border-b border-border last:border-0"
            >
              <td className="p-3 align-top whitespace-nowrap">
                {formatLocalDateTime(row.effectiveAt, timeZone)}
                <span className="block text-xs text-muted-foreground">
                  {m.recordedAt(formatLocalDateTime(row.createdAt, timeZone))}
                </span>
              </td>
              <td className="p-3 align-top">{kinds[row.kind] ?? row.kind}</td>
              <td className="p-3 align-top">
                {row.reason ? (reasonLabels[row.reason] ?? row.reason) : ""}
              </td>
              <td className="p-3 align-top">{row.note ?? ""}</td>
              <td className="p-3 align-top" data-cell="delta-physical">
                {row.deltaPhysical === 0n ? "" : deltaText(row.deltaPhysical, unit)}
              </td>
              <td className="p-3 align-top" data-cell="delta-committed">
                {row.deltaCommitted === 0n ? "" : deltaText(row.deltaCommitted, unit)}
              </td>
              <td className="p-3 align-top" data-cell="physical-after">
                {quantityText(row.physicalAfter, unit)}
              </td>
              <td className="p-3 align-top">{quantityText(row.committedAfter, unit)}</td>
              <td className="p-3 align-top">{row.actorLabel ?? m.system}</td>
              <td className="p-3 align-top text-muted-foreground">
                {row.refType && row.refId ? `${row.refType} ${row.refId}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
