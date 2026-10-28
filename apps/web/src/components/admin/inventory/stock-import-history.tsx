import type { SnapshotHistoryRow } from "@ecom/core";
import { formatDateTime } from "@/lib/format-date";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.stockImport.history;

export type StockImportHistoryRow = Omit<SnapshotHistoryRow, "takenAt" | "createdAt"> & {
  takenAt: string;
  createdAt: string;
};

/** Istoricul pozelor aplicate, cele mai noi primele (citire: `inventory.read`). */
export function StockImportHistory({
  rows,
  locale,
  timeZone,
}: {
  rows: readonly StockImportHistoryRow[];
  locale: string;
  timeZone: string;
}) {
  return (
    <section aria-labelledby="stock-import-history" className="flex flex-col gap-3">
      <h2 id="stock-import-history" className="text-lg font-semibold">
        {m.heading}
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {m.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-sm" aria-label={m.label}>
            <thead className="border-b border-border bg-border/30 text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {m.takenAt}
                </th>
                <th scope="col" className="px-3 py-2">
                  {m.uploadedAt}
                </th>
                <th scope="col" className="px-3 py-2">
                  {m.file}
                </th>
                <th scope="col" className="px-3 py-2">
                  {m.by}
                </th>
                <th scope="col" className="px-3 py-2">
                  {m.result}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0"
                  data-snapshot={row.id}
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatDateTime(row.takenAt, locale, timeZone)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatDateTime(row.createdAt, locale, timeZone)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="block break-all">{row.fileName ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.source[row.source] ?? row.source}
                      {row.fileHash ? ` · ${row.fileHash}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2">{row.actorLabel ?? "—"}</td>
                  <td className="px-3 py-2">{m.changed(row.changed, row.unchanged, row.zeroed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
