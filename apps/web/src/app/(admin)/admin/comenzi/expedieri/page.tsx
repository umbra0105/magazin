import type { Metadata } from "next";
import { can, listOrdersReadyToShip } from "@ecom/core";
import { getDb } from "@ecom/db";
import { PageHeader } from "@/components/admin/page-header";
import { BulkShipments, type BulkRowDto } from "@/components/admin/shipping/bulk-shipments";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import { getCarrierRuntime } from "@/lib/shipping";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.bulk;
const orders = getMessages().admin.orders;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Expedierea în masă (Faza 12): comenzile gata de expediat și AWB prin curierul activ. Cere `orders.fulfill`. */
export default async function BulkShipmentsPage() {
  const subject = await requireAdmin({ permission: "orders.fulfill" });
  const regional = await getSettings().getGroup("regional");
  const [{ rows }, carrier] = await Promise.all([
    listOrdersReadyToShip(getDb(), { limit: 200 }),
    getCarrierRuntime().activeCarrier(),
  ]);
  const dto: BulkRowDto[] = rows.map((row) => ({
    orderId: row.orderId,
    number: row.number,
    placedText: formatDateTime(row.placedAt, regional.locale, regional.timezone),
    destination: [row.localityName, row.countyName].filter(Boolean).join(", "),
    paymentText: orders.methods[row.paymentMethod] ?? row.paymentMethod,
    totalText: formatMoney(row.totalMinor, regional.currency, regional.locale),
    cod: row.paymentMethod === "cod" && row.paymentStatus === "pending",
  }));
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <BulkShipments
        rows={dto}
        carrierLabel={carrier ? carrier.label : null}
        canFulfill={can(subject, "orders.fulfill")}
      />
    </div>
  );
}
