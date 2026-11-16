import type { Metadata } from "next";
import { can } from "@ecom/core";
import { MaintenanceForm } from "@/components/admin/maintenance/maintenance-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.maintenance;

export const metadata: Metadata = { title: m.title };

/** Modul de mentenanță al vitrinei. Cere `settings.read`; salvarea cere `settings.write` (verificat și în acțiune). */
export default async function MaintenancePage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const current = await getSettings().getGroup("maintenance");
  const canSave = can(subject, "settings.write");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} description={m.description} notes={canSave ? [] : [m.readOnly]} />
      <MaintenanceForm
        canSave={canSave}
        maxLength={300}
        initial={{ enabled: current.enabled, message: current.message }}
      />
    </div>
  );
}
