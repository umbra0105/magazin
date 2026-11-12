import type { Metadata } from "next";
import { can } from "@ecom/core";
import { MeasureUnitManager } from "@/components/admin/measure-units/measure-unit-manager";
import { PageHeader } from "@/components/admin/page-header";
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
      <PageHeader
        title={m.title}
        count={units.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <MeasureUnitManager rows={units} canWrite={canWrite} />
    </div>
  );
}
