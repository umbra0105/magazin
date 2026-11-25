import type { Metadata } from "next";
import { can } from "@ecom/core";
import { Badge } from "@ecom/ui";
import { NirImportPanel } from "@/components/admin/nir-import/nir-import-panel";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getNirImportService } from "@/lib/nir-imports";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.nirImport;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const TONE = {
  previewed: "neutral",
  queued: "info",
  running: "info",
  completed: "success",
  failed: "danger",
} as const;

/**
 * Importul prețurilor de achiziție (NIR) din SmartBill (Faza 15). Cere `products.cost.import`; previzualizarea, raportul și lista
 * importurilor cer și `products.cost.view` (conțin costuri). Fără acest drept, pagina spune ce lipsește și nu arată nimic.
 */
export default async function NirImportPage() {
  const subject = await requireAdmin({ permission: "products.cost.import" });
  const canView = can(subject, "products.cost.view");
  const regional = await getSettings().getGroup("regional");
  const recent = canView ? await getNirImportService().list(subject) : [];

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={canView ? [] : [m.noCostView]}
      />
      {canView && <NirImportPanel />}
      {canView && (
        <section aria-label={m.recent.title} className="flex flex-col gap-3" data-nir-recent>
          <h2 className="text-subtitle">{m.recent.title}</h2>
          {recent.length === 0 ? (
            <p className="text-body text-ink-secondary">{m.recent.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-subtle p-3"
                >
                  <span className="text-ink-secondary">
                    {formatDateTime(item.createdAt, regional.locale, regional.timezone)}
                  </span>
                  <span className="font-medium">{item.fileName}</span>
                  <Badge variant={TONE[item.status]} dot>
                    {m.recent.status[item.status] ?? item.status}
                  </Badge>
                  {item.status === "completed" && (
                    <span className="text-ink-secondary">
                      {m.recent.result(
                        item.report.counters.updated,
                        item.report.counters.unchanged,
                      )}
                    </span>
                  )}
                  <a
                    className="ml-auto underline"
                    href={`/api/admin/nir-imports/${item.id}/report`}
                    download
                  >
                    {m.recent.report}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
