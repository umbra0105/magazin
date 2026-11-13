import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@ecom/core";
import {
  Badge,
  EmptyState,
  RowHeader,
  TAB_LIST_CLASS,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  buttonVariants,
  tabClass,
} from "@ecom/ui";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getProductExportService } from "@/lib/product-exports";
import { getProductImportService } from "@/lib/product-imports";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport.history;
const imagesText = getMessages().admin.productImport.images;

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
          className="text-body text-link underline-offset-2 hover:underline"
        >
          {m.back}
        </Link>
        <h1 className="text-title">{m.title}</h1>
        <p className="text-body text-ink-secondary">{m.description}</p>
        <nav aria-label={m.tabsLabel} className={`mt-2 ${TAB_LIST_CLASS}`} data-history-tabs>
          <Link
            href="/admin/produse/import/istoric"
            aria-current={tab === "imports" ? "page" : undefined}
            className={tabClass(tab === "imports")}
          >
            {m.tabs.imports}
          </Link>
          {canExport && (
            <Link
              href="/admin/produse/import/istoric?fila=exporturi"
              aria-current={tab === "exports" ? "page" : undefined}
              className={tabClass(tab === "exports")}
            >
              {m.tabs.exports}
            </Link>
          )}
        </nav>
      </header>

      {history && (
        <>
          <p className="text-body text-ink-secondary" data-history-retention>
            {m.retention(history.retentionDays)}
          </p>
          {history.items.length === 0 ? (
            <EmptyState title={m.empty} />
          ) : (
            <Table stacked aria-label={m.title} data-history-table>
              <THead>
                <Tr>
                  <Th priority="secondary">{m.columns.date}</Th>
                  <Th priority="tertiary">{m.columns.user}</Th>
                  <Th>{m.columns.file}</Th>
                  <Th priority="tertiary">{m.columns.profile}</Th>
                  <Th>{m.columns.state}</Th>
                  <Th priority="secondary">{m.columns.rows}</Th>
                  <Th>{m.columns.result}</Th>
                  <Th>{m.columns.actions}</Th>
                </Tr>
              </THead>
              <TBody>
                {history.items.map((item) => (
                  <Tr
                    key={item.id}
                    data-history-row={item.id}
                    data-state={item.state}
                    className="align-top"
                  >
                    <Td priority="secondary" className="whitespace-nowrap">
                      {when(item.createdAt)}
                    </Td>
                    <Td priority="tertiary">{item.userName ?? item.userEmail ?? m.unknownUser}</Td>
                    <RowHeader stack="lead">
                      <span className="font-medium break-all">{item.fileName}</span>
                      <span className="block text-label text-ink-secondary uppercase">
                        {item.format}
                      </span>
                    </RowHeader>
                    <Td priority="tertiary">{m.profiles[item.profile]}</Td>
                    <Td>
                      <Badge variant={STATE_VARIANT[item.state]}>{m.states[item.state]}</Badge>
                    </Td>
                    <Td priority="secondary" className="whitespace-nowrap">
                      {m.progress(item.processedRows, item.rowCount)}
                    </Td>
                    <Td stack="title">
                      {item.counts ? (
                        <>
                          <ul className="flex flex-wrap gap-x-3 gap-y-0.5" data-history-counts>
                            {(["new", "updated", "unchanged", "skipped", "errors"] as const).map(
                              (key) => (
                                <li key={key}>
                                  <span className="font-medium">{item.counts?.[key]}</span>{" "}
                                  <span className="text-ink-secondary">{m.counts[key]}</span>
                                </li>
                              ),
                            )}
                          </ul>
                          {item.counts.created && (
                            <p className="text-label text-ink-secondary" data-history-created>
                              {m.created(
                                item.counts.created.categories,
                                item.counts.created.brands,
                                item.counts.created.attributes,
                              )}
                            </p>
                          )}
                          {item.images && (
                            <p
                              className="text-label text-ink-secondary"
                              data-history-images-summary
                            >
                              {imagesText.heading}:{" "}
                              {imagesText.summary(
                                item.images.downloaded,
                                item.images.existing,
                                item.images.failed,
                                item.images.pending,
                              )}
                              {item.images.state === "interrupted"
                                ? ` — ${imagesText.states.interrupted}`
                                : ""}
                            </p>
                          )}
                        </>
                      ) : item.state === "interrupted" ? (
                        <p className="text-tone-problem-fg" data-history-interrupted>
                          {m.interrupted(item.processedRows, item.rowCount)}
                        </p>
                      ) : item.state === "failed" ? (
                        <p className="text-tone-problem-fg">{m.failed(item.errorMessage ?? "—")}</p>
                      ) : null}
                    </Td>
                    <Td stack="actions">
                      <Link
                        href={`/admin/produse/import/istoric/${item.id}`}
                        className="text-link underline-offset-2 hover:underline"
                        data-history-details
                      >
                        {m.details}
                      </Link>
                      {item.state === "completed" && !item.hasReport && (
                        <span className="block text-label text-ink-secondary">{m.purged}</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
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
              <span aria-current="page" className="text-body">
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
        <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
          {m.exports.forbidden}
        </p>
      )}
      {exportsList && (
        <section aria-labelledby="hist-exports" className="flex flex-col gap-3">
          <h2 id="hist-exports" className="text-section">
            {m.exports.title}
          </h2>
          <p className="text-body text-ink-secondary">{m.exports.description}</p>
          {exportsList.length === 0 ? (
            <EmptyState title={m.exports.empty} />
          ) : (
            <Table stacked aria-label={m.exports.title} data-exports-table>
              <THead>
                <Tr>
                  <Th>{m.exports.columns.date}</Th>
                  <Th priority="secondary">{m.exports.columns.user}</Th>
                  <Th>{m.exports.columns.scope}</Th>
                  <Th priority="secondary">{m.exports.columns.format}</Th>
                  <Th>{m.exports.columns.rows}</Th>
                  <Th>{m.exports.columns.state}</Th>
                </Tr>
              </THead>
              <TBody>
                {exportsList.map((item) => (
                  <Tr key={item.id} data-export-row data-state={item.state} className="align-top">
                    <RowHeader className="whitespace-nowrap font-normal">{when(item.at)}</RowHeader>
                    <Td priority="secondary">{item.actorLabel ?? m.unknownUser}</Td>
                    <Td>
                      {item.scope ? (m.exports.scopes[item.scope] ?? item.scope) : "—"}
                      {item.filtered && (
                        <span className="block text-label text-ink-secondary">
                          {m.exports.filtered}
                        </span>
                      )}
                      {item.includeTrash && (
                        <span className="block text-label text-ink-secondary">
                          {m.exports.trash}
                        </span>
                      )}
                    </Td>
                    <Td priority="secondary" className="uppercase">
                      {item.format ?? "—"}
                    </Td>
                    <Td>
                      {item.rows !== null && item.products !== null
                        ? m.exports.rowsAndProducts(item.rows, item.products)
                        : "—"}
                      {item.longDescriptions !== null && item.longDescriptions > 0 && (
                        <span
                          className="block text-label text-ink-secondary"
                          data-long-descriptions
                        >
                          {m.exports.longDescriptions(item.longDescriptions)}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge variant={item.state === "downloaded" ? "success" : "danger"}>
                        {m.exports.states[item.state]}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
