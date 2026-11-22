import type { Metadata } from "next";
import { can, listCodReconciliation } from "@ecom/core";
import { getDb } from "@ecom/db";
import { localDateTime } from "@ecom/shared";
import { PageHeader } from "@/components/admin/page-header";
import { CodReconciliation, type CodRowDto } from "@/components/admin/shipping/cod-reconciliation";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.cod;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Reconcilierea rambursului (Faza 12): comenzile cu ramburs expediate și nevirate. Citire cu `orders.read`, încasare cu `orders.mark_paid`. */
export default async function CodReconciliationPage() {
  const subject = await requireAdmin({ permission: "orders.read" });
  const regional = await getSettings().getGroup("regional");
  const { rows } = await listCodReconciliation(getDb(), { limit: 200 });
  const local = localDateTime(new Date(), regional.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const dto: CodRowDto[] = rows.map((row) => ({
    orderId: row.orderId,
    number: row.number,
    carrier: row.carrier,
    awb: row.awb,
    status: row.shipmentStatus,
    shippedText: formatDateTime(row.shippedAt, regional.locale, regional.timezone),
    totalMinor: row.totalMinor,
    totalText: formatMoney(row.totalMinor, regional.currency, regional.locale),
  }));
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <CodReconciliation rows={dto} canCollect={can(subject, "orders.mark_paid")} today={today} />
    </div>
  );
}
