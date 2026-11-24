import type { Metadata } from "next";
import { salesByGroup } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Button, Input, Label, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.customerSales;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_RANGE_DAYS = 800;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** `aaaa-ll-zz` → ziua la 00:00 UTC, sau `null` dacă nu e o zi care există. */
function parseDay(text: string | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text ? date : null;
}

/**
 * Vânzări per grup de clienți și avantajul acordat (Faza 15). Cere `reports.read`; nu conține costuri de achiziție. Perioada se
 * alege cu două date (implicit ultimele 30 de zile); «până la» e inclusiv.
 */
export default async function CustomerSalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const subject = await requireAdmin({ permission: "reports.read" });
  const params = await searchParams;
  const regional = await getSettings().getGroup("regional");

  const today = new Date();
  const todayDay = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const rawFrom = one(params["de"]);
  const rawTo = one(params["pana"]);
  const fromDay = parseDay(rawFrom) ?? new Date(todayDay.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);
  const toDay = parseDay(rawTo) ?? todayDay;
  const validRange =
    fromDay.getTime() <= toDay.getTime() &&
    toDay.getTime() - fromDay.getTime() <= MAX_RANGE_DAYS * DAY_MS;
  const report = validRange
    ? await salesByGroup(getDb(), subject, {
        from: fromDay,
        to: new Date(toDay.getTime() + DAY_MS),
      })
    : null;
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const isoDay = (date: Date) => date.toISOString().slice(0, 10);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <form method="get" noValidate className="flex flex-wrap items-end gap-3" data-sales-filters>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sales-from">{m.from}</Label>
          <Input id="sales-from" name="de" defaultValue={isoDay(fromDay)} maxLength={10} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sales-to">{m.to}</Label>
          <Input id="sales-to" name="pana" defaultValue={isoDay(toDay)} maxLength={10} />
        </div>
        <Button type="submit" variant="outline">
          {m.apply}
        </Button>
      </form>
      {!report && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {m.invalidRange}
        </p>
      )}
      {report && report.rows.length === 0 && (
        <p className="text-body text-ink-secondary" data-sales-empty>
          {m.empty}
        </p>
      )}
      {report && report.rows.length > 0 && (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th>{m.columns.group}</Th>
              <Th numeric>{m.columns.orders}</Th>
              <Th numeric>{m.columns.total}</Th>
              <Th numeric>{m.columns.advantage}</Th>
            </Tr>
          </THead>
          <TBody>
            {report.rows.map((row) => (
              <Tr key={row.groupId ?? "none"} data-sales-row={row.groupId ?? "none"}>
                <Td className="font-medium">{row.groupName ?? m.noGroup}</Td>
                <Td numeric>{row.orders.toLocaleString("ro-RO")}</Td>
                <Td numeric>{money(row.totalMinor)}</Td>
                <Td numeric>{money(row.advantageMinor)}</Td>
              </Tr>
            ))}
            <Tr data-sales-total className="font-semibold">
              <Td>{m.total}</Td>
              <Td numeric>{report.totals.orders.toLocaleString("ro-RO")}</Td>
              <Td numeric>{money(report.totals.totalMinor)}</Td>
              <Td numeric>{money(report.totals.advantageMinor)}</Td>
            </Tr>
          </TBody>
        </Table>
      )}
      <p className="text-label text-ink-secondary">{m.note}</p>
    </div>
  );
}
