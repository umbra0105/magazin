import type { Metadata } from "next";
import { can, listUninvoicedOrders } from "@ecom/core";
import { getDb } from "@ecom/db";
import { UninvoicedList, type UninvoicedRowDto } from "@/components/admin/invoicing/invoice-list";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.uninvoiced;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * «Comenzi confirmate fără factură» (Faza 13): comenzile care ar trebui să aibă factură și nu au (facturare oprită, factură eșuată
 * sau încă nepusă în coadă). Cât timp nu sunt facturate cu descărcare de gestiune, bucățile lor rămân angajate. Citire cu
 * `invoices.read`; «Emite factura» cu `invoices.write`.
 */
export default async function UninvoicedPage() {
  const subject = await requireAdmin({ permission: "invoices.read" });
  const settings = getSettings();
  const [regional, invoicing] = await Promise.all([
    settings.getGroup("regional"),
    settings.getGroup("invoicing"),
  ]);
  const { rows, total } = await listUninvoicedOrders(getDb(), { limit: 200 });
  const dto: UninvoicedRowDto[] = rows.map((row) => ({
    orderId: row.orderId,
    number: row.number,
    placedText: formatDateTime(row.placedAt, regional.locale, regional.timezone),
    method: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    totalText: formatMoney(row.totalMinor, regional.currency, regional.locale),
    openCommitments: row.openCommitments,
    failedInvoiceId: row.failedInvoiceId,
  }));
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={total > 0 ? [m.total(total)] : []}
      />
      <UninvoicedList
        rows={dto}
        canWrite={can(subject, "invoices.write")}
        providerOn={invoicing.provider !== ""}
      />
    </div>
  );
}
