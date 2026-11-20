import type { Metadata } from "next";
import Link from "next/link";
import { can, listEmailLog, listEmailOverrides, type EmailLogView } from "@ecom/core";
import { getDb } from "@ecom/db";
import { TEMPLATE_CATALOG, templateDefinition } from "@ecom/jobs";
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
  tabClass,
} from "@ecom/ui";
import { ResendLogButton } from "@/components/admin/email/template-forms";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { EMAIL_STATUS_TONE } from "@/lib/order-tones";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.email;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * Șabloanele de email și jurnalul de trimiteri (Faza 11). Cere `email.read`; suprascrierea, emailul de test și retrimiterea cer
 * `email.write`. Jurnalul arată și emailurile blocate (dead-letter) după toate încercările.
 */
export default async function EmailTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ vedere?: string; filtru?: string; pagina?: string }>;
}) {
  const subject = await requireAdmin({ permission: "email.read" });
  const query = await searchParams;
  const tab = query.vedere === "jurnal" ? "log" : "templates";
  const db = getDb();
  const regional = await getSettings().getGroup("regional");
  const when = (date: Date) => formatDateTime(date, regional.locale, regional.timezone);
  const canWrite = can(subject, "email.write");
  const logView: EmailLogView =
    query.filtru === "esuate" ? "failed" : query.filtru === "coada" ? "queued" : "all";
  const page = Math.max(1, Number.parseInt(query.pagina ?? "1", 10) || 1);
  const [overrides, log] = await Promise.all([
    listEmailOverrides(db),
    tab === "log"
      ? listEmailLog(db, { view: logView, page, pageSize: PAGE_SIZE })
      : Promise.resolve(null),
  ]);
  const failed = log?.failed ?? (await db.emailDispatch.count({ where: { status: "failed" } }));
  const custom = new Set(overrides.map((o) => o.template));
  const logHref = (filtru: string, p = 1) =>
    `/admin/comenzi/sabloane-email?vedere=jurnal${filtru ? `&filtru=${filtru}` : ""}${p > 1 ? `&pagina=${p}` : ""}`;
  const pageCount = log ? Math.max(1, Math.ceil(log.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <nav aria-label={m.title} className={TAB_LIST_CLASS}>
        <Link
          href="/admin/comenzi/sabloane-email"
          aria-current={tab === "templates" ? "page" : undefined}
          className={tabClass(tab === "templates")}
        >
          {m.tabs.templates}
        </Link>
        <Link
          href={logHref("")}
          aria-current={tab === "log" ? "page" : undefined}
          className={tabClass(tab === "log")}
        >
          {m.tabs.log}
          {failed > 0 ? ` (${failed})` : ""}
        </Link>
      </nav>

      {tab === "templates" ? (
        <Table stacked aria-label={m.tabs.templates}>
          <THead>
            <Tr>
              <Th priority="primary">{m.columns.template}</Th>
              <Th priority="secondary">{m.columns.audience}</Th>
              <Th priority="primary">{m.columns.status}</Th>
              <Th priority="tertiary">{m.columns.override}</Th>
              <Th priority="primary">
                <span className="sr-only">{m.columns.actions}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {TEMPLATE_CATALOG.map((definition) => (
              <Tr key={definition.key} data-template={definition.key}>
                <RowHeader stack="title" className="font-medium">
                  <Link
                    href={`/admin/comenzi/sabloane-email/${definition.key}`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {definition.label}
                  </Link>
                  <span className="block text-label font-normal text-ink-secondary">
                    {definition.description}
                  </span>
                </RowHeader>
                <Td priority="secondary">{m.audience[definition.audience]}</Td>
                <Td priority="primary">
                  <Badge variant={definition.wired ? "success" : "neutral"} dot>
                    {definition.wired ? m.wired : m.notWired}
                  </Badge>
                </Td>
                <Td priority="tertiary">
                  <Badge variant={custom.has(definition.key) ? "info" : "neutral"}>
                    {custom.has(definition.key) ? m.hasOverride : m.noOverride}
                  </Badge>
                </Td>
                <Td priority="primary" stack="actions">
                  <Link
                    href={`/admin/comenzi/sabloane-email/${definition.key}`}
                    className="inline-flex min-h-11 items-center text-link underline-offset-2 hover:underline md:min-h-0"
                  >
                    {m.open}
                  </Link>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        log && (
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink-secondary">{m.log.description}</p>
            <nav aria-label={m.log.title} className={TAB_LIST_CLASS}>
              <Link
                href={logHref("")}
                aria-current={logView === "all" ? "page" : undefined}
                className={tabClass(logView === "all")}
              >
                {m.log.views.all}
              </Link>
              <Link
                href={logHref("esuate")}
                aria-current={logView === "failed" ? "page" : undefined}
                className={tabClass(logView === "failed")}
              >
                {m.log.views.failed(log.failed)}
              </Link>
              <Link
                href={logHref("coada")}
                aria-current={logView === "queued" ? "page" : undefined}
                className={tabClass(logView === "queued")}
              >
                {m.log.views.queued}
              </Link>
            </nav>
            {log.rows.length === 0 ? (
              <EmptyState title={m.log.empty} />
            ) : (
              <Table stacked aria-label={m.log.title}>
                <THead>
                  <Tr>
                    <Th priority="primary">{m.columns.template}</Th>
                    <Th priority="secondary">{m.columns.recipient}</Th>
                    <Th priority="primary">{m.columns.status}</Th>
                    <Th priority="tertiary">{m.columns.order}</Th>
                    <Th priority="tertiary">{m.columns.when}</Th>
                    <Th priority="primary">
                      <span className="sr-only">{m.columns.actions}</span>
                    </Th>
                  </Tr>
                </THead>
                <TBody>
                  {log.rows.map((row) => {
                    const label = templateDefinition(row.template)?.label ?? row.template;
                    return (
                      <Tr key={row.id}>
                        <RowHeader stack="title" className="font-medium">
                          {label}
                          {row.lastError && (
                            <span className="block text-label font-normal text-tone-problem-fg">
                              {row.lastError}
                            </span>
                          )}
                        </RowHeader>
                        <Td priority="secondary" className="break-all">
                          {row.recipient}
                        </Td>
                        <Td priority="primary">
                          <Badge variant={EMAIL_STATUS_TONE[row.status] ?? "neutral"} dot>
                            {m.log.statuses[row.status] ?? row.status}
                          </Badge>
                          {row.attempts > 0 && (
                            <span className="ml-2 text-label text-ink-secondary">
                              {m.columns.attempts}: {row.attempts}
                            </span>
                          )}
                        </Td>
                        <Td priority="tertiary">
                          {row.orderId ? (
                            <Link
                              href={`/admin/comenzi/${row.orderId}`}
                              className="text-link underline-offset-2 hover:underline"
                            >
                              {row.orderNumber}
                            </Link>
                          ) : (
                            m.log.noOrder
                          )}
                        </Td>
                        <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                          {when(row.sentAt ?? row.createdAt)}
                        </Td>
                        <Td priority="primary" stack="actions">
                          {canWrite && !["queued", "sending"].includes(row.status) && (
                            <ResendLogButton dispatchId={row.id} label={label} />
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            )}
            {pageCount > 1 && (
              <nav
                aria-label="Paginare"
                className="flex items-center justify-between gap-3 text-body"
              >
                {page > 1 ? (
                  <Link
                    className="text-link underline-offset-2 hover:underline"
                    href={logHref(query.filtru ?? "", page - 1)}
                  >
                    Înapoi
                  </Link>
                ) : (
                  <span className="text-ink-disabled">Înapoi</span>
                )}
                <span className="tabular-nums text-ink-secondary">{`Pagina ${page} din ${pageCount}`}</span>
                {page < pageCount ? (
                  <Link
                    className="text-link underline-offset-2 hover:underline"
                    href={logHref(query.filtru ?? "", page + 1)}
                  >
                    Înainte
                  </Link>
                ) : (
                  <span className="text-ink-disabled">Înainte</span>
                )}
              </nav>
            )}
          </div>
        )
      )}
    </div>
  );
}
