import type { Metadata } from "next";
import Link from "next/link";
import { can, countInvoicesNeedingAttention, listInvoices } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Button, Input, Label, Select } from "@ecom/ui";
import { InvoiceList, type InvoiceRowDto } from "@/components/admin/invoicing/invoice-list";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { toInvoiceDocDto } from "@/lib/invoice-dto";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.documents;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const STATUSES = ["queued", "issuing", "issued", "failed", "skipped"] as const;
const KINDS = ["proforma", "invoice", "storno"] as const;
type Status = (typeof STATUSES)[number];
type Kind = (typeof KINDS)[number];

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Lista documentelor fiscale (Faza 13). Citire cu `invoices.read`; «Reîncearcă» cu `invoices.write`. */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const subject = await requireAdmin({ permission: "invoices.read" });
  const params = await searchParams;
  const status = STATUSES.find((value) => value === one(params["stare"]));
  const kind = KINDS.find((value) => value === one(params["tip"]));
  const search = (one(params["q"]) ?? "").trim().slice(0, 80);
  const pageIndex = Math.max(0, Number.parseInt(one(params["pagina"]) ?? "0", 10) || 0);
  const PAGE = 50;
  const db = getDb();
  const regional = await getSettings().getGroup("regional");
  const [{ rows, total }, attention] = await Promise.all([
    listInvoices(db, {
      ...(status ? { status: status as Status } : {}),
      ...(kind ? { kind: kind as Kind } : {}),
      ...(search ? { search } : {}),
      limit: PAGE,
      offset: pageIndex * PAGE,
    }),
    countInvoicesNeedingAttention(db),
  ]);
  const format = {
    currency: regional.currency,
    locale: regional.locale,
    timezone: regional.timezone,
  };
  const dto: InvoiceRowDto[] = rows.map((row) => ({
    ...toInvoiceDocDto(row, format),
    orderNumber: row.orderNumber,
  }));
  const hasNext = (pageIndex + 1) * PAGE < total;
  const link = (page: number): string => {
    const qs = new URLSearchParams();
    if (status) qs.set("stare", status);
    if (kind) qs.set("tip", kind);
    if (search) qs.set("q", search);
    if (page > 0) qs.set("pagina", String(page));
    const text = qs.toString();
    return text ? `/admin/comenzi/facturi?${text}` : "/admin/comenzi/facturi";
  };
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={attention > 0 ? [m.attention(attention)] : []}
      />
      <form method="get" noValidate className="flex flex-wrap items-end gap-3" data-invoice-filters>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invoice-q">{m.searchLabel}</Label>
          <Input
            id="invoice-q"
            name="q"
            defaultValue={search}
            maxLength={80}
            className="min-w-64"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invoice-status">{m.statusFilter}</Label>
          <Select id="invoice-status" name="stare" defaultValue={status ?? ""}>
            <option value="">{m.all}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {m.statuses[value]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invoice-kind">{m.kindFilter}</Label>
          <Select id="invoice-kind" name="tip" defaultValue={kind ?? ""}>
            <option value="">{m.all}</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {m.kinds[value]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {m.filter}
        </Button>
      </form>
      <InvoiceList rows={dto} canWrite={can(subject, "invoices.write")} />
      <nav className="flex gap-4 text-body" aria-label={m.title}>
        {pageIndex > 0 ? <Link href={link(pageIndex - 1)}>‹</Link> : null}
        {hasNext ? <Link href={link(pageIndex + 1)}>›</Link> : null}
      </nav>
    </div>
  );
}
