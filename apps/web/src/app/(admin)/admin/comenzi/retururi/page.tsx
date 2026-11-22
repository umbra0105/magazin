import type { Metadata } from "next";
import Link from "next/link";
import { listAdminReturns, RETURN_STATUSES } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Badge, Button, Input, Label, Select, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.returns;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  requested: "warning",
  approved: "info",
  awaiting_shipment: "info",
  received: "info",
  inspected: "warning",
  refunded: "success",
  rejected: "danger",
  cancelled: "neutral",
};

/** Lista retururilor (Faza 14), cu filtre pe stare și căutare după numărul returului sau al comenzii. Citire cu `returns.view`. */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin({ permission: "returns.view" });
  const params = await searchParams;
  const status = RETURN_STATUSES.find((value) => value === one(params["stare"]));
  const search = (one(params["q"]) ?? "").trim().slice(0, 40);
  const page = Math.max(1, Number.parseInt(one(params["pagina"]) ?? "1", 10) || 1);
  const regional = await getSettings().getGroup("regional");
  const list = await listAdminReturns(getDb(), {
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    page,
    pageSize: 25,
  });
  const link = (target: number): string => {
    const qs = new URLSearchParams();
    if (status) qs.set("stare", status);
    if (search) qs.set("q", search);
    if (target > 1) qs.set("pagina", String(target));
    const text = qs.toString();
    return text ? `/admin/comenzi/retururi?${text}` : "/admin/comenzi/retururi";
  };
  const hasNext = list.page * list.pageSize < list.total;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <form method="get" noValidate className="flex flex-wrap items-end gap-3" data-return-filters>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="return-q">{m.searchLabel}</Label>
          <Input id="return-q" name="q" defaultValue={search} maxLength={40} className="min-w-64" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="return-status">{m.statusFilter}</Label>
          <Select id="return-status" name="stare" defaultValue={status ?? ""}>
            <option value="">{m.all}</option>
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
        <Link href="/admin/comenzi/retururi/motive" className="text-body underline">
          {m.report}
        </Link>
      </form>
      {list.rows.length === 0 ? (
        <p className="text-body text-ink-secondary" data-returns-empty>
          {m.empty}
        </p>
      ) : (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th priority="primary">{m.cols.number}</Th>
              <Th priority="primary">{m.cols.order}</Th>
              <Th priority="primary">{m.cols.status}</Th>
              <Th priority="secondary">{m.cols.requested}</Th>
              <Th priority="secondary" numeric>
                {m.cols.items}
              </Th>
              <Th priority="secondary" numeric>
                {m.cols.refund}
              </Th>
            </Tr>
          </THead>
          <TBody>
            {list.rows.map((row) => (
              <Tr key={row.id} data-return-row>
                <Td priority="primary">
                  <Link href={`/admin/comenzi/retururi/${row.id}`} className="underline">
                    R-{row.number}
                  </Link>
                </Td>
                <Td priority="primary">
                  <Link href={`/admin/comenzi/${row.orderId}`} className="underline">
                    {row.orderNumber}
                  </Link>
                </Td>
                <Td priority="primary">
                  <Badge variant={TONE[row.status] ?? "neutral"}>
                    {m.status[row.status] ?? row.status}
                  </Badge>
                </Td>
                <Td priority="secondary">
                  {formatDateTime(row.requestedAt, regional.locale, regional.timezone)}
                </Td>
                <Td priority="secondary" numeric>
                  {row.itemCount}
                </Td>
                <Td priority="secondary" numeric>
                  {row.refundMinor === null
                    ? "—"
                    : formatMoney(row.refundMinor, regional.currency, regional.locale)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <nav className="flex gap-4 text-body" aria-label={m.title}>
        {list.page > 1 ? <Link href={link(list.page - 1)}>‹</Link> : null}
        {hasNext ? <Link href={link(list.page + 1)}>›</Link> : null}
      </nav>
    </div>
  );
}
