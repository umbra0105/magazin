import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@ecom/core";
import { Button, Input, Label, Select } from "@ecom/ui";
import { CustomerTable } from "@/components/admin/customers/customer-table";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getCustomerGroupService } from "@/lib/customers";
import { formatDateTime } from "@/lib/format-date";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.customers;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const PAGE_SIZE = 25;
const TONES = ["neutral", "info", "success", "warning", "danger"] as const;

/**
 * Lista clienților (Faza 15): grupul fiecăruia, filtru după grup, căutare și mutare în grup (individual sau în masă). Citirea cere
 * `customers.read` (emailul se vede doar cu `customers.read_pii`); mutarea cere `customers.write`, verificat pe server la fiecare acțiune.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const subject = await requireAdmin({ permission: "customers.read" });
  const params = await searchParams;
  const service = getCustomerGroupService();
  const groups = await service.list(subject);
  const search = (one(params["q"]) ?? "").trim().slice(0, 80);
  const groupParam = one(params["grup"]) ?? "";
  const groupId = groups.some((group) => group.id === groupParam) ? groupParam : "";
  const page = Math.max(1, Number.parseInt(one(params["pagina"]) ?? "1", 10) || 1);
  const list = await service.listCustomers(subject, {
    ...(search ? { query: search } : {}),
    ...(groupId ? { groupId } : {}),
    page,
    pageSize: PAGE_SIZE,
  });
  const regional = await getSettings().getGroup("regional");
  const canWrite = can(subject, "customers.write");

  const link = (target: number): string => {
    const qs = new URLSearchParams();
    if (search) qs.set("q", search);
    if (groupId) qs.set("grup", groupId);
    if (target > 1) qs.set("pagina", String(target));
    const text = qs.toString();
    return text ? `/admin/clienti?${text}` : "/admin/clienti";
  };
  const hasNext = list.page * list.pageSize < list.total;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        title={m.title}
        count={list.total}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <form
        method="get"
        noValidate
        className="flex flex-wrap items-end gap-3"
        data-customer-filters
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer-q">{m.searchLabel}</Label>
          <Input
            id="customer-q"
            name="q"
            defaultValue={search}
            maxLength={80}
            className="min-w-64"
            aria-describedby="customer-q-help"
          />
          <p id="customer-q-help" className="text-label text-ink-secondary">
            {m.searchHelp}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer-group">{m.groupFilter}</Label>
          <Select id="customer-group" name="grup" defaultValue={groupId}>
            <option value="">{m.allGroups}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {m.filter}
        </Button>
      </form>

      {list.rows.length === 0 ? (
        <p className="text-body text-ink-secondary" data-customers-empty>
          {m.empty}
        </p>
      ) : (
        <CustomerTable
          rows={list.rows.map((row) => ({
            id: row.id,
            name: row.name,
            email: row.email,
            emailVerified: row.emailVerified,
            joinedText: formatDateTime(row.createdAt, regional.locale, regional.timezone),
            groupId: row.groupId,
          }))}
          groups={groups.map((group) => ({
            id: group.id,
            name: group.name,
            tone: TONES.find((tone) => tone === group.tone) ?? "neutral",
            isSystem: group.isSystem,
            isActive: group.isActive,
          }))}
          canWrite={canWrite}
        />
      )}
      <nav className="flex gap-4 text-body" aria-label={m.title}>
        {list.page > 1 ? (
          <Link href={link(list.page - 1)} rel="prev">
            ‹ {m.pagination.previous}
          </Link>
        ) : null}
        <span className="text-ink-secondary">{m.pagination.page(list.page)}</span>
        {hasNext ? (
          <Link href={link(list.page + 1)} rel="next">
            {m.pagination.next} ›
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
