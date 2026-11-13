import type { Metadata } from "next";
import { can } from "@ecom/core";
import { PageHeader } from "@/components/admin/page-header";
import { WarehouseManager } from "@/components/admin/warehouses/warehouse-manager";
import { requireAdmin } from "@/lib/admin-page";
import { getWarehouseService } from "@/lib/inventory";
import { getMessages } from "@/messages";

const m = getMessages().admin.warehouses;

export const metadata: Metadata = { title: m.title };

/**
 * Depozitele. Apare doar cu steagul `multiWarehouse` pornit (oprit: 404) și cere `inventory.read`; scrierea cere
 * `inventory.write`. Depozitul implicit se poate redenumi, dar nu se dezactivează.
 */
export default async function WarehousesPage() {
  const subject = await requireAdmin({ permission: "inventory.read", feature: "multiWarehouse" });
  const rows = await getWarehouseService().list(subject);
  const canWrite = can(subject, "inventory.write");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={rows.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <WarehouseManager rows={rows} canWrite={canWrite} />
    </div>
  );
}
