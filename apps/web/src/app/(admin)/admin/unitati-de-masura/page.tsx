import type { Metadata } from "next";
import { can } from "@ecom/core";
import { MeasureUnitManager } from "@/components/admin/measure-units/measure-unit-manager";
import { requireAdmin } from "@/lib/admin-page";
import { getMeasureUnitService } from "@/lib/inventory";
import { getMessages } from "@/messages";

const m = getMessages().admin.measureUnits;

export const metadata: Metadata = { title: m.title };

/** Unitățile de măsură. Cere `products.read`; scrierea cere `products.write`. */
export default async function MeasureUnitsPage() {
  const subject = await requireAdmin({ permission: "products.read" });
  const units = await getMeasureUnitService().list(subject);
  const canWrite = can(subject, "products.write");

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
      <MeasureUnitManager rows={units} canWrite={canWrite} />
    </div>
  );
}
