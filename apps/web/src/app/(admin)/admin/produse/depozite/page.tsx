import type { Metadata } from "next";
import { can } from "@ecom/core";
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
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canWrite && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
      </header>
      <WarehouseManager rows={rows} canWrite={canWrite} />
    </div>
  );
}
