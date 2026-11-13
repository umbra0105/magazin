import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportError } from "@ecom/core";
import {
  Badge,
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
import {
  ImageFailures,
  ImageProgress,
  RetryImagesButton,
} from "@/components/admin/products/product-import-images";
import { WooReportExtras } from "@/components/admin/products/product-import-woo";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getProductImportService } from "@/lib/product-imports";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const root = getMessages().admin.productImport;
const m = root.history;

export const metadata: Metadata = { title: m.detail.breadcrumb };

type SearchParams = Record<string, string | string[] | undefined>;

/** Cel mult atâtea rânduri în pagină; restul se văd în CSV. */
const MAX_SHOWN = 500;
const FILTERS = ["all", "error", "skipped", "new", "updated"] as const;
type Filter = (typeof FILTERS)[number];

const one = (value: string | string[] | undefined): string =>
  ((Array.isArray(value) ? value[0] : value) ?? "").trim();

const STATE_VARIANT = {
  completed: "success",
  failed: "danger",
  interrupted: "danger",
  running: "info",
} as const;

/**
 * Detaliile unui import din istoric: contoarele și raportul final pe rânduri (număr rând, SKU, rezultat,
 * motiv), cu filtru pe rezultat și descărcare CSV. Cere `products.write`. Raportul nu conține niciodată
 * costul, descrieri sau câmpuri lungi (mesajele de domeniu sunt scurte și scrise pentru administrator).
 */
export default async function ImportHistoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.write" });
  const { id } = await params;
  const query = await searchParams;
  const requested = one(query["rezultat"]);
  const filter: Filter = (FILTERS as readonly string[]).includes(requested)
    ? (requested as Filter)
    : "all";

  let detail;
  try {
    detail = await getProductImportService().getHistory(subject, id);
  } catch (error) {
    if (error instanceof ImportError && error.code === "IMPORT_NOT_FOUND") notFound();
    throw error;
  }
  const { item, report, retentionDays } = detail;
  const imageFailures =
    item.images && item.images.failed > 0
      ? await getProductImportService().imageFailures(subject, id)
      : [];
  const regional = await getSettings().getGroup("regional");
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);

  const entries = report?.entries ?? [];
  const matching = filter === "all" ? entries : entries.filter((e) => e.outcome === filter);
  const shown = matching.slice(0, MAX_SHOWN);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse/import/istoric"
          className="text-body text-link underline-offset-2 hover:underline"
        >
          {m.detail.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title break-all">{m.detail.title(item.fileName)}</h1>
          <Badge variant={STATE_VARIANT[item.state]} data-history-state={item.state}>
            {m.states[item.state]}
          </Badge>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-body sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              [m.detail.summary.date, when(item.createdAt)],
              [m.detail.summary.finished, item.finishedAt ? when(item.finishedAt) : "—"],
              [m.detail.summary.user, item.userName ?? item.userEmail ?? m.unknownUser],
              [m.detail.summary.profile, m.profiles[item.profile] ?? item.profile],
              [m.detail.summary.format, item.format.toUpperCase()],
              [m.detail.summary.rows, String(item.rowCount)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="text-ink-secondary">{label}:</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {item.state === "interrupted" && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          data-history-interrupted
        >
          {m.interrupted(item.processedRows, item.rowCount)}
        </p>
      )}
      {item.state === "failed" && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {m.failed(item.errorMessage ?? "—")}
        </p>
      )}

      {item.counts && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-history-counts>
          {(["new", "updated", "unchanged", "skipped", "errors"] as const).map((key) => (
            <div key={key} className="rounded-lg border border-line-subtle p-3" data-count={key}>
              <dt className="text-label text-ink-secondary">{root.check.counts[key]}</dt>
              <dd className="text-title">{item.counts?.[key]}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.counts?.created && (
        <p className="text-body text-ink-secondary" data-history-created>
          {m.created(
            item.counts.created.categories,
            item.counts.created.brands,
            item.counts.created.attributes,
          )}
        </p>
      )}

      {item.images && (
        <section
          aria-labelledby="hist-images"
          className="flex flex-col gap-3 rounded-lg border border-line-subtle p-3"
          data-history-images
        >
          <h2 id="hist-images" className="text-section">
            {root.images.heading}
          </h2>
          <ImageProgress progress={item.images} />
          {(item.images.state === "interrupted" ||
            (item.images.state === "done" && item.images.failed > 0)) && (
            <RetryImagesButton importId={item.id} />
          )}
          <ImageFailures failures={imageFailures} />
        </section>
      )}

      {item.state === "completed" && !report && (
        <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body" data-history-purged>
          {m.detail.purged(retentionDays)}
        </p>
      )}
      {item.state !== "completed" && item.state !== "failed" && (
        <p role="note" className="text-body text-ink-secondary">
          {m.detail.noFinalReport}
        </p>
      )}

      {report && (
        <>
          {item.reportUntil && (
            <p className="text-label text-ink-secondary">
              {m.detail.until(when(item.reportUntil))}
            </p>
          )}
          {report.woo && <WooReportExtras woo={report.woo} />}
          {report.fileWarnings.length > 0 && (
            <div>
              <h2 className="text-body font-semibold">{root.check.fileWarnings}</h2>
              <ul className="list-disc pl-5 text-body" data-file-warnings>
                {report.fileWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <section aria-labelledby="hist-rows" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="hist-rows" className="text-section">
                {root.check.entries}
              </h2>
              <a
                href={`/api/admin/product-imports/${item.id}/report`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                download
                data-import-download
              >
                {m.detail.download}
              </a>
            </div>
            <nav aria-label={m.detail.filterLabel} className={TAB_LIST_CLASS} data-history-filters>
              {FILTERS.map((value) => (
                <Link
                  key={value}
                  href={
                    value === "all"
                      ? `/admin/produse/import/istoric/${item.id}`
                      : `/admin/produse/import/istoric/${item.id}?rezultat=${value}`
                  }
                  aria-current={filter === value ? "page" : undefined}
                  className={tabClass(filter === value)}
                >
                  {m.detail.filters[value]}
                </Link>
              ))}
            </nav>
            {shown.length === 0 ? (
              <p className="text-body text-ink-secondary">{m.detail.noRows}</p>
            ) : (
              <>
                <p className="text-label text-ink-secondary" data-history-shown>
                  {m.detail.shown(shown.length, matching.length)}
                  {report.truncated ? ` · ${root.check.truncated(entries.length)}` : ""}
                </p>
                <Table stacked aria-label={root.check.entries}>
                  <THead>
                    <Tr>
                      <Th numeric>{root.check.row}</Th>
                      <Th>{root.check.sku}</Th>
                      <Th>{root.check.result}</Th>
                      <Th>{root.check.reason}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {shown.map((entry) => (
                      <Tr
                        key={`${entry.row}-${entry.sku}`}
                        data-report-row={entry.row}
                        data-outcome={entry.outcome}
                        className="align-top"
                      >
                        <Td numeric>{entry.row}</Td>
                        <Td className="break-all">{entry.sku || "—"}</Td>
                        <Td>{root.check.outcomes[entry.outcome]}</Td>
                        <Td stack="title">
                          {entry.messages.length > 0 ? (
                            <ul className="list-disc pl-4">
                              {entry.messages.map((message) => (
                                <li key={message}>{message}</li>
                              ))}
                            </ul>
                          ) : entry.changed.length > 0 ? (
                            root.check.willChange(entry.changed.join(", "))
                          ) : null}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
