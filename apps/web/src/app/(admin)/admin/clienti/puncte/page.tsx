import type { Metadata } from "next";
import Link from "next/link";
import { Button, Input, Label, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getLoyaltyAdminService } from "@/lib/loyalty-admin";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty.list;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Clienții cu puncte (Faza 15b), cu căutare după nume sau email. Cere `loyalty.view` (flag `loyalty`); emailul întreg se vede
 * doar cu `customers.read_pii`.
 */
export default async function LoyaltyCustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const subject = await requireAdmin({ permission: "loyalty.view", feature: "loyalty" });
  const query = (one((await searchParams)["q"]) ?? "").trim().slice(0, 80);
  const rows = await getLoyaltyAdminService().search(subject, query);
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <form method="get" noValidate className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="points-q">{m.searchLabel}</Label>
          <Input
            id="points-q"
            name="q"
            defaultValue={query}
            maxLength={80}
            className="min-w-64"
            aria-describedby="points-q-help"
          />
          <p id="points-q-help" className="text-label text-ink-secondary">
            {m.searchHelp}
          </p>
        </div>
        <Button type="submit" variant="outline">
          {m.search}
        </Button>
      </form>
      {rows.length === 0 ? (
        <p className="text-body text-ink-secondary" data-points-empty>
          {m.empty}
        </p>
      ) : (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th>{m.columns.name}</Th>
              <Th>{m.columns.email}</Th>
              <Th numeric>{m.columns.balance}</Th>
              <Th>{m.columns.open}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.id} data-points-customer={row.id}>
                <Td className="font-medium">{row.name}</Td>
                <Td>{row.email}</Td>
                <Td numeric>{row.balance.toLocaleString("ro-RO")}</Td>
                <Td>
                  <Link href={`/admin/clienti/puncte/${row.id}`} className="underline">
                    {m.open}
                    <span className="sr-only"> {row.name}</span>
                  </Link>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {rows.length === 50 ? <p className="text-label text-ink-secondary">{m.limited}</p> : null}
    </div>
  );
}
