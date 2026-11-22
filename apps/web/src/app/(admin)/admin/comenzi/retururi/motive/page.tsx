import type { Metadata } from "next";
import Link from "next/link";
import { RETURN_STATUSES, returnReasonReport } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Button, Input, Label, Select, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { parseReportDates } from "@/lib/return-report";
import { getMessages } from "@/messages";

const m = getMessages().admin.returns;
const r = m.reasonReport;

export const metadata: Metadata = { title: r.title };
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Raportul de motive de retur (Faza 14): retururi, linii și bucăți pe motiv, pe perioadă și stare; export CSV pentru Excel. */
export default async function ReturnReasonsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin({ permission: "returns.view" });
  const params = await searchParams;
  const status = RETURN_STATUSES.find((value) => value === one(params["stare"]));
  const dates = parseReportDates(one(params["de-la"]), one(params["pana-la"]));
  const rows = dates.ok
    ? await returnReasonReport(getDb(), {
        ...(dates.from ? { from: dates.from } : {}),
        ...(dates.to ? { to: dates.to } : {}),
        ...(status ? { status } : {}),
      })
    : [];
  const qs = new URLSearchParams();
  if (dates.fromText) qs.set("de-la", dates.fromText);
  if (dates.toText) qs.set("pana-la", dates.toText);
  if (status) qs.set("stare", status);
  const csvHref = `/api/admin/retururi/motive${qs.toString() ? `?${qs.toString()}` : ""}`;
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title={r.title} description={r.description} />
      <form method="get" noValidate className="flex flex-wrap items-end gap-3" data-report-filters>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rr-from">{r.from}</Label>
          <Input
            id="rr-from"
            name="de-la"
            defaultValue={dates.fromText}
            placeholder={r.dateHelp}
            maxLength={10}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rr-to">{r.to}</Label>
          <Input
            id="rr-to"
            name="pana-la"
            defaultValue={dates.toText}
            placeholder={r.dateHelp}
            maxLength={10}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rr-status">{r.status}</Label>
          <Select id="rr-status" name="stare" defaultValue={status ?? ""}>
            <option value="">{r.allExceptCancelled}</option>
            {RETURN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {m.status[value]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {m.filter}
        </Button>
      </form>
      {!dates.ok ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {r.invalidDate}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-body text-ink-secondary" data-report-empty>
          {r.empty}
        </p>
      ) : (
        <Table stacked aria-label={r.title}>
          <THead>
            <Tr>
              <Th priority="primary">{r.cols.reason}</Th>
              <Th priority="primary" numeric>
                {r.cols.returns}
              </Th>
              <Th priority="secondary" numeric>
                {r.cols.lines}
              </Th>
              <Th priority="secondary" numeric>
                {r.cols.pieces}
              </Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.reasonCode} data-report-row>
                <Td priority="primary">{m.reasons[row.reasonCode] ?? row.reasonCode}</Td>
                <Td priority="primary" numeric>
                  {row.returns}
                </Td>
                <Td priority="secondary" numeric>
                  {row.lines}
                </Td>
                <Td priority="secondary" numeric>
                  {row.pieces}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {dates.ok && rows.length > 0 ? (
          <a href={csvHref} className="text-body underline" data-report-csv>
            {r.export}
          </a>
        ) : null}
        <Link href="/admin/comenzi/retururi" className="text-body underline">
          {m.title}
        </Link>
      </div>
    </div>
  );
}
