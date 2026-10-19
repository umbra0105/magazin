import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@ecom/core";
import { Badge, buttonVariants } from "@ecom/ui";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getProductExportService } from "@/lib/product-exports";
import { getProductImportService } from "@/lib/product-imports";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport.history;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  ((Array.isArray(value) ? value[0] : value) ?? "").trim();

const STATE_VARIANT = {
  completed: "success",
  failed: "danger",
  interrupted: "danger",
  running: "info",
} as const;

/**
 * Istoricul importurilor aplicate (și al exporturilor), pentru toți utilizatorii. Cere `products.write`, ca
 * importul însuși; fila de exporturi cere în plus `products.export`. Nu scrie nimic. Raportul detaliat pe
 * rânduri se păstrează `import.historyRetentionDays` zile; contoarele rămân.
 */
export default async function ImportHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.write" });
  const params = await searchParams;
  const canExport = can(subject, "products.export");
  const tab = one(params["fila"]) === "exporturi" ? "exports" : "imports";
  const regional = await getSettings().getGroup("regional");
  const when = (date: Date | string) => formatDateTime(date, regional.locale, regional.timezone);

  const pageNumber = Number.parseInt(one(params["pagina"]), 10);
  const history =
    tab === "imports"
      ? await getProductImportService().listHistory(
          subject,
          Number.isFinite(pageNumber) ? pageNumber : 1,
        )
      : null;
  const exportsList =
    tab === "exports" && canExport ? await getProductExportService().history(subject) : null;

  const href = (page: number): string =>
    `/admin/produse/import/istoric${page > 1 ? `?pagina=${page}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse/import"
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {m.back}
        </Link>
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        <nav aria-label={m.tabsLabel} className="mt-2 flex gap-2" data-history-tabs>
          <Link
            href="/admin/produse/import/istoric"
            aria-current={tab === "imports" ? "page" : undefined}
            className={buttonVariants({
              variant: tab === "imports" ? "default" : "outline",
              size: "sm",
            })}
          >
            {m.tabs.imports}
          </Link>
          {canExport && (
            <Link
              href="/admin/produse/import/istoric?fila=exporturi"
              aria-current={tab === "exports" ? "page" : undefined}
              className={buttonVariants({
                variant: tab === "exports" ? "default" : "outline",
                size: "sm",
              })}
            >
              {m.tabs.exports}
            </Link>
          )}
        </nav>
      </header>

      {history && (
        <>
          <p className="text-sm text-muted-foreground" data-history-retention>
            {m.retention(history.retentionDays)}
          </p>
          {history.items.length === 0 ? (
            <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
              {m.empty}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[60rem] text-left text-sm" data-history-table>
                <thead className="border-b border-border bg-border/30">
                  <tr>
                    {(
                      [
                        m.columns.date,
                        m.columns.user,
                        m.columns.file,
                        m.columns.profile,
                        m.columns.state,
                        m.columns.rows,
                        m.columns.result,
                        m.columns.actions,
                      ] as const
                    ).map((label) => (
                      <th key={label} scope="col" className="p-3 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.items.map((item) => (
                    <tr
                      key={item.id}
                      data-history-row={item.id}
                      data-state={item.state}
                      className="border-b border-border align-top last:border-0"
                    >
                      <td className="p-3 whitespace-nowrap">{when(item.createdAt)}</td>
                      <td className="p-3">{item.userName ?? item.userEmail ?? m.unknownUser}</td>
                      <td className="p-3">
                        <span className="font-medium break-all">{item.fileName}</span>
                        <span className="block text-xs text-muted-foreground uppercase">
                          {item.format}
                        </span>
                      </td>
                      <td className="p-3">{m.profiles[item.profile]}</td>
                      <td className="p-3">
                        <Badge variant={STATE_VARIANT[item.state]}>{m.states[item.state]}</Badge>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {m.progress(item.processedRows, item.rowCount)}
                      </td>
                      <td className="p-3">
                        {item.counts ? (
                          <>
                            <ul className="flex flex-wrap gap-x-3 gap-y-0.5" data-history-counts>
                              {(["new", "updated", "unchanged", "skipped", "errors"] as const).map(
                                (key) => (
                                  <li key={key}>
                                    <span className="font-medium">{item.counts?.[key]}</span>{" "}
                                    <span className="text-muted-foreground">{m.counts[key]}</span>
                                  </li>
                                ),
                              )}
                            </ul>
                            {item.counts.created && (
                              <p className="text-xs text-muted-foreground" data-history-created>
                                {m.created(
                                  item.counts.created.categories,
                                  item.counts.created.brands,
                                  item.counts.created.attributes,
                                )}
                              </p>
                            )}
                          </>
                        ) : item.state === "interrupted" ? (
                          <p className="text-danger" data-history-interrupted>
                            {m.interrupted(item.processedRows, item.rowCount)}
                          </p>
                        ) : item.state === "failed" ? (
                          <p className="text-danger">{m.failed(item.errorMessage ?? "—")}</p>
                        ) : null}
                      </td>
                      <td className="p-3">
                        <Link
                          href={`/admin/produse/import/istoric/${item.id}`}
                          className="text-primary underline-offset-2 hover:underline"
                          data-history-details
                        >
                          {m.details}
                        </Link>
                        {item.state === "completed" && !item.hasReport && (
                          <span className="block text-xs text-muted-foreground">{m.purged}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.pageCount > 1 && (
            <nav
              aria-label={m.pagination.label}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              {history.page > 1 ? (
                <Link
                  href={href(history.page - 1)}
                  rel="prev"
                  className={buttonVariants({ variant: "outline" })}
                >
                  {m.pagination.previous}
                </Link>
              ) : (
                <span />
              )}
              <span aria-current="page" className="text-sm">
                {m.pagination.pageOf(history.page, history.pageCount)}
              </span>
              {history.page < history.pageCount ? (
                <Link
                  href={href(history.page + 1)}
                  rel="next"
                  className={buttonVariants({ variant: "outline" })}
                >
                  {m.pagination.next}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}

      {tab === "exports" && !canExport && (
        <p role="note" className="rounded-md border border-border p-3 text-sm">
          {m.exports.forbidden}
        </p>
      )}
      {exportsList && (
        <section aria-labelledby="hist-exports" className="flex flex-col gap-3">
          <h2 id="hist-exports" className="text-lg font-semibold">
            {m.exports.title}
          </h2>
          <p className="text-sm text-muted-foreground">{m.exports.description}</p>
          {exportsList.length === 0 ? (
            <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
              {m.exports.empty}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[44rem] text-left text-sm" data-exports-table>
                <thead className="border-b border-border bg-border/30">
                  <tr>
                    {(
                      [
                        m.exports.columns.date,
                        m.exports.columns.user,
                        m.exports.columns.scope,
                        m.exports.columns.format,
                        m.exports.columns.rows,
                        m.exports.columns.state,
                      ] as const
                    ).map((label) => (
                      <th key={label} scope="col" className="p-3 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {exportsList.map((item) => (
                    <tr
                      key={item.id}
                      data-export-row
                      data-state={item.state}
                      className="border-b border-border align-top last:border-0"
                    >
                      <td className="p-3 whitespace-nowrap">{when(item.at)}</td>
                      <td className="p-3">{item.actorLabel ?? m.unknownUser}</td>
                      <td className="p-3">
                        {item.scope ? (m.exports.scopes[item.scope] ?? item.scope) : "—"}
                        {item.filtered && (
                          <span className="block text-xs text-muted-foreground">
                            {m.exports.filtered}
                          </span>
                        )}
                        {item.includeTrash && (
                          <span className="block text-xs text-muted-foreground">
                            {m.exports.trash}
                          </span>
                        )}
                      </td>
                      <td className="p-3 uppercase">{item.format ?? "—"}</td>
                      <td className="p-3">
                        {item.rows !== null && item.products !== null
                          ? m.exports.rowsAndProducts(item.rows, item.products)
                          : "—"}
                      </td>
                      <td className="p-3">
                        <Badge variant={item.state === "downloaded" ? "success" : "danger"}>
                          {m.exports.states[item.state]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
