import type { Metadata } from "next";
import { TBody, THead, Table, Td, Th, Tr, buttonVariants } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getLoyaltyAdminService } from "@/lib/loyalty-admin";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty.debt;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Raportul «datorie în puncte» (Faza 15b): fără date personale. Cere `loyalty.view`; CSV-ul vine din ruta cu aceeași gardă. */
export default async function LoyaltyDebtPage() {
  const subject = await requireAdmin({ permission: "loyalty.view", feature: "loyalty" });
  const [report, regional] = await Promise.all([
    getLoyaltyAdminService().debtReport(subject),
    getSettings().getGroup("regional"),
  ]);
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const month = (key: string) =>
    new Intl.DateTimeFormat(regional.locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${key}-01T00:00:00.000Z`));
  const cards = [
    {
      key: "available",
      label: m.available,
      points: report.availablePoints,
      minor: report.availableMinor,
    },
    { key: "pending", label: m.pending, points: report.pendingPoints, minor: report.pendingMinor },
  ];
  return (
    <div className="flex max-w-4xl flex-col gap-6" data-loyalty-debt>
      <PageHeader title={m.title} description={m.description} />
      <dl className="grid gap-4 sm:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.key}
            className="rounded-lg bg-surface-subtle p-4"
            data-debt-card={card.key}
          >
            <dt className="text-label text-ink-secondary">{card.label}</dt>
            <dd className="text-title tabular-nums">{card.points.toLocaleString("ro-RO")}</dd>
            <dd className="text-label text-ink-secondary">{m.value(money(card.minor))}</dd>
          </div>
        ))}
        <div className="rounded-lg bg-surface-subtle p-4" data-debt-card="negative">
          <dt className="text-label text-ink-secondary">{m.negative}</dt>
          <dd className="text-title tabular-nums">
            {report.negativePoints.toLocaleString("ro-RO")}
          </dd>
        </div>
      </dl>
      <p>
        <a
          href="/api/admin/loyalty/debt"
          className={buttonVariants({ variant: "outline" })}
          download
        >
          {m.export}
        </a>
      </p>
      <section aria-labelledby="debt-months" className="flex flex-col gap-2">
        <h2 id="debt-months" className="text-section">
          {m.monthsTitle}
        </h2>
        {report.months.length === 0 ? (
          <p className="text-body text-ink-secondary">{m.empty}</p>
        ) : (
          <Table stacked aria-label={m.monthsTitle}>
            <THead>
              <Tr>
                <Th>{m.columns.month}</Th>
                <Th numeric>{m.columns.points}</Th>
                <Th numeric>{m.columns.value}</Th>
              </Tr>
            </THead>
            <TBody>
              {report.months.map((row) => (
                <Tr key={row.month} data-debt-month={row.month}>
                  <Td>{month(row.month)}</Td>
                  <Td numeric>{row.points.toLocaleString("ro-RO")}</Td>
                  <Td numeric>{money(row.valueMinor)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>
      <p className="text-label text-ink-secondary">{m.note}</p>
    </div>
  );
}
